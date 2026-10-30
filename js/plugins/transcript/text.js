// Plain text in the same "[hh:mm:ss] Speaker: text" format (copy-pasted from Word or chat).
import { parseBracketLines, looksLikeBracketTranscript } from './common.js';

export default {
  id: 'bracket-text',
  label: 'ข้อความ .txt รูปแบบ [เวลา] ชื่อ: ข้อความ',
  extensions: ['.txt', '.md'],
  sniff: looksLikeBracketTranscript,
  async parse(file) {
    const lines = parseBracketLines((await file.text()).split(/\r?\n/));
    if (!lines.length) throw new Error('ไม่พบบรรทัดรูปแบบ [00:00:00] ชื่อ: ข้อความ');
    return { lines };
  },
};
