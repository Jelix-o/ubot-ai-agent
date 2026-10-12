function decodeHtmlEntities(input) {
  if (!input) return '';

  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' '
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1].toLowerCase() === 'x';
      const raw = isHex ? entity.slice(2) : entity.slice(1);
      const codePoint = parseInt(raw, isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    }
    return named[entity] || _;
  });
}

function stripHtml(input) {
  return decodeHtmlEntities(
    (input || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
    .replace(/\s+([.,!?;:\]})/]+)/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/([\u3400-\u9fff])\s+([.·])/g, '$1$2')
    .replace(/([.·])\s+([\u3400-\u9fff])/g, '$1$2');
}

function absolutizeUrl(base, maybeRelative) {
  if (!maybeRelative) return '';
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

function extractImageUrls(html, limit = 3, baseUrl = '') {
  const urls = [];
  const imgRegex = /<img[^>]+src="([^"]+)"/gi;
  let match;

  while ((match = imgRegex.exec(html || '')) !== null && urls.length < limit) {
    const src = absolutizeUrl(baseUrl, match[1]);
    if (/avatar|logo|advert|default\.png|view\/img\//i.test(src)) continue;
    if (!urls.includes(src)) {
      urls.push(src);
    }
  }

  return urls;
}

module.exports = {
  decodeHtmlEntities,
  stripHtml,
  absolutizeUrl,
  extractImageUrls
};
