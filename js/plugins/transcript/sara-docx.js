// Word transcript from SA+RA ("Download Transcript"): one paragraph per utterance,
// formatted "[hh:mm:ss] Speaker: text".
import { readZipText } from '../../io/unzip.js';
import { parseBracketLines } from './common.js';

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** Plain text of each <w:p> paragraph in document.xml */
export function docxParagraphs(xml) {
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
  return paras.map((p) => {
    let text = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;
    let m;
    while ((m = re.exec(p))) {
      if (m[1] != null) text += decodeXml(m[1]);
      else text += m[0] === '<w:tab/>' ? '\t' : '\n';
    }
    return text;
  });
}

export default {
  id: 'sara-docx',
  label: 'Word (.docx) จาก SA+RA',
  extensions: ['.docx'],
  async parse(file) {
    const xml = await readZipText(file, 'word/document.xml');
    if (!xml) throw new Error('ไม่พบเนื้อหาในไฟล์ Word');
    const paragraphs = docxParagraphs(xml).flatMap((p) => p.split('\n'));
    const lines = parseBracketLines(paragraphs);
    if (!lines.length) throw new Error('ไม่พบบรรทัดรูปแบบ [00:00:00] ชื่อ: ข้อความ ในไฟล์ Word');
    return { lines };
  },
};
