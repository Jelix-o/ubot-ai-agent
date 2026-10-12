const mikan = require('../sources/mikan');
const nyaa = require('../sources/nyaa');
const kpkuang = require('../sources/kpkuang');
const btbtla = require('../sources/btbtla');
const onelou = require('../sources/onelou');
const sukebei = require('../sources/sukebei');

const SITES = [mikan, nyaa, kpkuang, btbtla, onelou, sukebei];
const SITE_BY_ID = new Map(SITES.map(site => [site.id, site]));
const TYPE_SITE_ORDER = {
  anime: ['mikan', 'nyaa', 'onelou', 'kpkuang', 'btbtla'],
  movie: ['btbtla', 'kpkuang', 'onelou', 'nyaa'],
  adult: ['sukebei']
};

function listSites() {
  return SITES.map(site => site.describe());
}

function getSiteById(id) {
  return SITE_BY_ID.get(id) || null;
}

function getSitesForType(type) {
  return (TYPE_SITE_ORDER[type] || [])
    .map(getSiteById)
    .filter(Boolean)
    .filter(site => site.supportsType(type));
}

module.exports = {
  listSites,
  getSiteById,
  getSitesForType
};
