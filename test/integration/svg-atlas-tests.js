/* global render, window, waitForSkins, mipPixels */
const {chromium} = require('playwright-chromium');
const test = require('tap').test;
const path = require('path');

const indexHTML = path.resolve(__dirname, 'index.html');

// Paint editor style costumes that can go into an atlas.
const simple = (width, height, color) => `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" ` +
    `viewBox="0,0,${width},${height}"><g transform="translate(-200.5,-150.25)">` +
    `<g data-paper-data="{&quot;isPaintingLayer&quot;:true}" ` +
    `fill-rule="nonzero" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10" ` +
    `stroke-dasharray="" stroke-dashoffset="0" style="mix-blend-mode: normal">` +
    `<path d="M202,152h${width - 6}v${height - 5}z" ` +
    `fill="${color}" stroke="#000000" stroke-width="2"/></g></g></svg>`;
const gradient = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0,0,40,40"><defs>` +
    `<linearGradient id="a"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>` +
    `</defs><path d="M0,0h40v40z" fill="url(#a)"/></svg>`;

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`file://${indexHTML}`);

    // Helpers in the page.
    await page.evaluate(() => {
        render.useSVGAtlas = true;
        window.waitForSkins = ids => Promise.all(ids.map(id => new Promise(resolve => {
            const check = () => (render._allSkins[id]._svgImageLoaded ? resolve() : setTimeout(check, 10));
            check();
        })));
        window.mipPixels = (id, scale) => {
            const skin = render._allSkins[id];
            render.gl.deleteTexture(skin.createMIP(scale));
            const {width, height} = skin._canvas;
            return Array.from(skin._context.getImageData(0, 0, width, height).data);
        };
    });

    const svgs = [
        simple(60, 40, '#ff0000'),
        simple(90, 120, '#00ff00'),
        simple(33.27, 71.5, '#0000ff'),
        gradient,
        // Values the paint editor sometimes writes, which browsers ignore.
        simple(50, 50, '#ffff00')
            .replace('stroke-width="2"', 'stroke-width="NaN"')
            .replace('stroke-miterlimit="10"', 'stroke-miterlimit="none"')
            .replace('style="mix-blend-mode: normal"', 'style="mix-blend-mode: normal;"')
    ];

    await test('costumes created during the same task are drawn from an atlas', async t => {
        const result = await page.evaluate(async list => {
            render.useSVGAtlas = false;
            const standalone = list.map(svg => render.createSVGSkin(svg));
            render.useSVGAtlas = true;
            const batched = list.map(svg => render.createSVGSkin(svg));
            const sizesBeforeEnd = batched.map(id => render.getSkinSize(id));
            const loadedBeforeEnd = batched.some(id => render._allSkins[id]._svgImageLoaded);
            await waitForSkins(standalone.concat(batched));
            const out = {
                sizesBeforeEnd,
                loadedBeforeEnd,
                inAtlas: batched.map(id => !!render._allSkins[id]._atlasEntry),
                standaloneMeta: standalone.map(id => [render.getSkinSize(id), render._allSkins[id].rotationCenter]),
                batchedMeta: batched.map(id => [render.getSkinSize(id), render._allSkins[id].rotationCenter]),
                pixels: []
            };
            for (let i = 0; i < list.length; i++) {
                for (const scale of [0.25, 1, 2, 8]) {
                    const a = mipPixels(standalone[i], scale);
                    const b = mipPixels(batched[i], scale);
                    let differing = 0;
                    let opacityFlips = 0;
                    for (let j = 0; j < a.length; j += 4) {
                        if (a[j] !== b[j] || a[j + 1] !== b[j + 1] || a[j + 2] !== b[j + 2] || a[j + 3] !== b[j + 3]) {
                            differing++;
                        }
                        if ((a[j + 3] === 0) !== (b[j + 3] === 0)) opacityFlips++;
                    }
                    out.pixels.push({costume: i, scale, total: a.length / 4, differing, opacityFlips});
                }
            }
            for (const id of standalone.concat(batched)) render.destroySkin(id);
            return out;
        }, svgs);

        t.same(result.sizesBeforeEnd, result.standaloneMeta.map(m => m[0]), 'sizes are available right away');
        t.notOk(result.loadedBeforeEnd, 'nothing loads before the task ends');
        t.same(result.inAtlas, [true, true, true, false, true], 'only simple costumes use the atlas');
        t.same(result.batchedMeta, result.standaloneMeta, 'same sizes and rotation centers');
        for (const {costume, scale, total, differing, opacityFlips} of result.pixels) {
            if (costume === 2) {
                // How fractional sizes are laid out varies between browser versions, so antialiasing at the edges
                // may differ slightly. The shape must still be the same.
                t.ok(opacityFlips <= Math.max(2, total * 0.01),
                    `costume ${costume} at ${scale}x: ${differing}/${total} differ, ${opacityFlips} in opacity`);
            } else {
                t.equal(differing, 0, `costume ${costume} at ${scale}x is identical`);
            }
        }
        t.end();
    });

    await test('changing or destroying costumes while waiting for an atlas', async t => {
        const result = await page.evaluate(async svg => {
            const ids = [0, 1, 2, 3].map(() => render.createSVGSkin(svg));
            render.updateSVGSkin(ids[0], svg);
            render.destroySkin(ids[1]);
            const remaining = [ids[0], ids[2], ids[3]];
            await waitForSkins(remaining);
            const entry = render._allSkins[ids[2]]._atlasEntry;
            const atlas = entry.atlas;
            const out = {
                updatedInAtlas: !!render._allSkins[ids[0]]._atlasEntry,
                othersInAtlas: !!render._allSkins[ids[3]]._atlasEntry,
                srcWhileUsed: atlas.image.hasAttribute('src')
            };
            for (const id of remaining) render.destroySkin(id);
            out.srcAfterDestroy = atlas.image.hasAttribute('src');
            out.entryDropsSkin = entry.skin === null && entry.onLoad === null;
            return out;
        }, svgs[0]);

        t.notOk(result.updatedInAtlas, 'updated costume loads on its own');
        t.ok(result.othersInAtlas, 'other costumes still use the atlas');
        t.ok(result.srcWhileUsed, 'atlas is kept while costumes use it');
        t.notOk(result.srcAfterDestroy, 'atlas is released once no costume uses it');
        t.ok(result.entryDropsSkin, 'atlas does not keep destroyed skins reachable');
        t.end();
    });

    await test('costumes alone in their task or created while disabled are not batched', async t => {
        const result = await page.evaluate(async svg => {
            render.useSVGAtlas = false;
            const disabled = [render.createSVGSkin(svg), render.createSVGSkin(svg)];
            render.useSVGAtlas = true;
            await new Promise(resolve => setTimeout(resolve));
            const alone = render.createSVGSkin(svg);
            const ids = [alone].concat(disabled);
            await waitForSkins(ids);
            const out = ids.map(id => !!render._allSkins[id]._atlasEntry);
            for (const id of ids) render.destroySkin(id);
            return out;
        }, svgs[0]);
        t.same(result, [false, false, false]);
        t.end();
    });

    await browser.close();
})().catch(err => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
});
