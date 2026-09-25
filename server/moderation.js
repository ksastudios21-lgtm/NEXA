const defaultBlockedTerms = ['كسم', 'زب', 'قحبة', 'fuck', 'shit'];

function normalizeModerationText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/([^\p{L}\p{N}\s])(?=[\p{L}\p{N}])/gu, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/(\p{L})\1{2,}/gu, '$1$1')
    .trim();
}

export function contentCheck(value) {
  const text = ` ${normalizeModerationText(value)} `;
  const configuredTerms = (process.env.CONTENT_BLOCKLIST || '').split(',');
  const blockedTerms = [...new Set([...defaultBlockedTerms, ...configuredTerms])]
    .map(normalizeModerationText)
    .filter(Boolean);

  return blockedTerms.some(term => text.includes(` ${term} `)) ? 'CONTENT_REJECTED' : null;
}