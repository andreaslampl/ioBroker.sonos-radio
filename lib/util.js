'use strict';

/** Object ID part from a name: "Küche Nord" -> "kueche_nord", "Radio 88,6" -> "radio_88_6". */
function slug(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

module.exports = { slug };
