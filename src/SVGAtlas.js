/**
 * @fileoverview
 * Draw many SVG costumes from a few large SVG images ("atlases"), batching the costumes created during each task.
 *
 * Chromium keeps internal state for every live SVG image and walks all of it at the end of every task, so each
 * SVG image makes every later task slower and loading N SVG costumes costs roughly N^2. A few large images
 * avoid that.
 *
 * Only a small subset of what the paint editor writes is admitted: groups and paths with plain attribute values
 * (no gradients, IDs, references or units), at natural size with a viewBox starting at 0,0. Their contents are
 * copied into the atlas unchanged. Everything else loads as its own image as before.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Tiles start at multiples of this. The smallest scale SVGSkin renders at is 1/256, so tiles always start on a
 * whole device pixel and the offset cancels out exactly.
 */
const TILE_ALIGNMENT = 256;

/** Atlases are at most this wide and tall, keeping coordinates well within single precision. */
const MAX_ATLAS_SIZE = 16384;

/** Larger costumes load on their own. */
const MAX_COSTUME_SIZE = 2048;

/** An atlas is started once this many costumes or this much markup is waiting. */
const MAX_COSTUMES_PER_ATLAS = 128;
const MAX_MARKUP_PER_ATLAS = 2 * 1024 * 1024;

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/;
const NUMBER_LIST = /^(none|[\d\s.,e-]*)$/;
// Colors, keywords, path data and transforms. No units, %, quotes, url() or other references.
const PLAIN = /^[\w\s.,#()-]*$/;
const FUNCTIONS = ['rgb', 'rgba', 'matrix', 'translate', 'scale', 'rotate'];

const any = () => true;
const isNumber = value => NUMBER.test(value);
// The paint editor sometimes writes these. Browsers ignore them, the same way in an atlas as on their own.
const isNumberOrIgnored = value => isNumber(value) || value === 'NaN' || value === 'none';
const isPlain = value => {
    if (!PLAIN.test(value)) return false;
    const calls = value.match(/[\w-]+\s*\(/g) || [];
    return calls.every(call => FUNCTIONS.indexOf(call.replace(/[\s(]/g, '')) !== -1);
};

const GROUP_ATTRIBUTES = {
    'fill': isPlain,
    'stroke': isPlain,
    'fill-rule': isPlain,
    'stroke-width': isNumberOrIgnored,
    'stroke-linecap': isPlain,
    'stroke-linejoin': isPlain,
    'stroke-miterlimit': isNumberOrIgnored,
    'stroke-dasharray': value => NUMBER_LIST.test(value),
    'stroke-dashoffset': isNumber,
    'opacity': isNumber,
    'fill-opacity': isNumber,
    'stroke-opacity': isNumber,
    'transform': isPlain,
    // Only affect text, which isn't admitted. The paint editor writes them on groups.
    'font-family': any,
    'font-weight': any,
    'font-size': any,
    'text-anchor': any,
    // Paint editor metadata.
    'data-paper-data': any,
    'style': value => /^mix-blend-mode: normal;?$/.test(value.trim())
};
const ELEMENTS = {
    g: GROUP_ATTRIBUTES,
    path: Object.assign({d: isPlain}, GROUP_ATTRIBUTES)
};

/**
 * @param {SVGSVGElement} svgTag The normalized root element from loadSvgString.
 * @returns {boolean} true if the costume can be drawn from an atlas.
 */
const isAtlasable = svgTag => {
    // Root: <svg version="1.1" xmlns=... xmlns:xlink=... width=W height=H viewBox="0,0,W,H">
    for (const attr of Array.from(svgTag.attributes)) {
        if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
        if (attr.namespaceURI !== null) return false;
        if (['version', 'width', 'height', 'viewBox'].indexOf(attr.localName) === -1) return false;
    }
    if (svgTag.namespaceURI !== SVG_NS) return false;
    const width = isNumber(svgTag.getAttribute('width')) ? parseFloat(svgTag.getAttribute('width')) : NaN;
    const height = isNumber(svgTag.getAttribute('height')) ? parseFloat(svgTag.getAttribute('height')) : NaN;
    // Standalone images under a pixel wide have a natural size of 0 and are never drawn.
    if (!(width >= 1 && height >= 1 && width <= MAX_COSTUME_SIZE && height <= MAX_COSTUME_SIZE)) return false;
    const viewBox = (svgTag.getAttribute('viewBox') || '').split(/[\s,]+/);
    if (viewBox.length !== 4 || !viewBox.every(isNumber) || +viewBox[0] !== 0 || +viewBox[1] !== 0 ||
        +viewBox[2] !== width || +viewBox[3] !== height) {
        return false;
    }

    for (const element of Array.from(svgTag.getElementsByTagName('*'))) {
        // A prefix would refer to a declaration on the costume's root, which isn't copied.
        if (element.namespaceURI !== SVG_NS || element.prefix !== null ||
            !Object.prototype.hasOwnProperty.call(ELEMENTS, element.localName)) {
            return false;
        }
        const allowed = ELEMENTS[element.localName];
        for (const attr of Array.from(element.attributes)) {
            if (
                attr.namespaceURI !== null ||
                !Object.prototype.hasOwnProperty.call(allowed, attr.localName) ||
                !allowed[attr.localName](attr.value)
            ) {
                return false;
            }
        }
    }
    return true;
};

/**
 * Chromium lays an SVG image out at its size rounded down to a layout unit (1/64 px), then stretches that to the
 * real size when drawing it. The tile does the same with two nested <svg>s, so that the costume gets the same
 * transform it would have as its own image.
 *
 * A standalone image is only clipped by the edge of the canvas, but nested <svg>s clip to their viewport, and a
 * clip with fractional edges changes how everything inside it is antialiased. So the inner <svg>s don't clip and
 * the outermost one clips to the cell, on whole pixels.
 *
 * @param {object} entry Builder entry.
 * @returns {string} Markup for the tile.
 */
const createTileMarkup = entry => {
    const {svgText, width, height} = entry;
    const contentStart = svgText.indexOf('>') + 1;
    const contentEnd = svgText.lastIndexOf('</svg>');
    const contents = contentEnd === -1 ? '' : svgText.slice(contentStart, contentEnd);
    const layoutWidth = Math.floor(width * 64) / 64;
    const layoutHeight = Math.floor(height * 64) / 64;
    return `<svg x="${entry.x}" y="${entry.y}" width="${entry.cellWidth}" height="${entry.cellHeight}">` +
        `<svg width="${width}" height="${height}" viewBox="0 0 ${layoutWidth} ${layoutHeight}" ` +
        `preserveAspectRatio="none" overflow="visible">` +
        `<svg width="${layoutWidth}" height="${layoutHeight}" viewBox="0 0 ${width} ${height}" overflow="visible">` +
        `${contents}</svg></svg></svg>`;
};

class SVGAtlas {
    /**
     * @param {Array<object>} entries Builder entries, already laid out.
     * @param {number} width Width of the atlas.
     * @param {number} height Height of the atlas.
     */
    constructor (entries, width, height) {
        const markup = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}">` +
            `${entries.map(createTileMarkup).join('')}</svg>`;

        this._entries = entries;
        this._liveCount = entries.length;
        for (const entry of entries) entry.atlas = this;

        this.image = new Image();
        this.image.onload = () => {
            for (const entry of this._entries) {
                entry.svgText = null;
                if (entry.skin) entry.onLoad();
            }
        };
        this.image.onerror = () => {
            // Not expected, but if it happens, load each costume on its own like before.
            for (const entry of this._entries) {
                const {skin, svgText, onLoad} = entry;
                if (skin) {
                    skin._detachFromAtlas();
                    skin._loadStandalone(svgText, onLoad);
                }
            }
        };
        this.image.src = `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;
    }

    /**
     * A costume no longer uses this atlas. Once none do, the image is released.
     * @param {object} entry The costume's entry.
     */
    release (entry) {
        entry.skin = null;
        entry.onLoad = null;
        this._liveCount--;
        if (this._liveCount === 0) {
            this.image.onload = null;
            this.image.onerror = null;
            // Frees the SVG document right away instead of at the next garbage collection.
            this.image.removeAttribute('src');
        }
    }
}

/**
 * Gathers the costumes created during a task and turns them into atlases.
 */
class SVGAtlasBuilder {
    constructor () {
        this._reset();
    }

    _reset () {
        this._pending = [];
        this._pendingMarkup = 0;
        this._rowX = 0;
        this._rowY = 0;
        this._rowHeight = 0;
        this._width = 0;
    }

    /**
     * @param {SVGSkin} skin The skin. Its _atlasEntry is set.
     * @param {string} svgText Serialized SVG, accepted by isAtlasable.
     * @param {number} width Width of the costume.
     * @param {number} height Height of the costume.
     * @param {function} onLoad Called when the costume is ready to draw.
     */
    add (skin, svgText, width, height, onLoad) {
        const cellWidth = Math.ceil(width / TILE_ALIGNMENT) * TILE_ALIGNMENT;
        const cellHeight = Math.ceil(height / TILE_ALIGNMENT) * TILE_ALIGNMENT;
        if (this._rowX + cellWidth > MAX_ATLAS_SIZE) {
            this._rowX = 0;
            this._rowY += this._rowHeight;
            this._rowHeight = 0;
        }
        if (this._rowY + cellHeight > MAX_ATLAS_SIZE) {
            this.flush();
        }

        const entry = {
            skin,
            svgText,
            width,
            height,
            onLoad,
            x: this._rowX,
            y: this._rowY,
            cellWidth,
            cellHeight,
            builder: this,
            atlas: null
        };
        skin._atlasEntry = entry;
        this._pending.push(entry);
        this._pendingMarkup += svgText.length;
        this._rowX += cellWidth;
        this._rowHeight = Math.max(this._rowHeight, cellHeight);
        this._width = Math.max(this._width, this._rowX);

        if (this._pending.length >= MAX_COSTUMES_PER_ATLAS || this._pendingMarkup >= MAX_MARKUP_PER_ATLAS) {
            this.flush();
        }
    }

    /**
     * A costume was changed or destroyed before its atlas was created. Its space in the layout stays empty.
     * @param {object} entry The costume's entry.
     */
    remove (entry) {
        const index = this._pending.indexOf(entry);
        if (index !== -1) {
            this._pending.splice(index, 1);
            this._pendingMarkup -= entry.svgText.length;
        }
    }

    /**
     * Start loading everything added so far.
     */
    flush () {
        const entries = this._pending;
        const width = this._width;
        const height = this._rowY + this._rowHeight;
        this._reset();
        if (entries.length > 1) {
            try {
                // eslint-disable-next-line no-new
                new SVGAtlas(entries, width, height);
                return;
            } catch (e) {
                // Fall through to loading each costume on its own.
            }
        }
        for (const entry of entries) {
            entry.skin._atlasEntry = null;
            entry.skin._loadStandalone(entry.svgText, entry.onLoad);
        }
    }
}

module.exports = {
    SVGAtlasBuilder,
    isAtlasable
};
