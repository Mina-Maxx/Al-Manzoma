import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { buildContentDisposition } from '../src/utils/contentDisposition.js';
import { sanitizeFilename } from '../src/modules/documents/service.js';
import {
  createTestCompany,
  createTestUser,
  createTestMembership,
  createTestQuarry,
  createTestPermission,
  generateAuthHeader,
} from './helpers.js';
import { MembershipRole } from '../src/types/index.js';

const app = createApp();

describe('Arabic Filename Download & RFC 6266 / RFC 5987 Compliance Suite', () => {
  describe('buildContentDisposition unit tests', () => {
    it('1. formats pure Arabic filename with safe ASCII fallback and RFC 5987 UTF-8 encoding', () => {
      const header = buildContentDisposition('رخصة المحجر.pdf');
      expect(header).toBe(
        'attachment; filename="document.pdf"; filename*=UTF-8\'\'%D8%B1%D8%AE%D8%B5%D8%A9%20%D8%A7%D9%84%D9%85%D8%AD%D8%AC%D8%B1.pdf'
      );
      // Verify ASCII parameter contains no non-ASCII or raw percent-encoded Arabic
      const matchAscii = header.match(/filename="([^"]+)"/);
      expect(matchAscii).not.toBeNull();
      expect(matchAscii![1]).toBe('document.pdf');
      expect(matchAscii![1]).not.toContain('%');

      // Verify UTF-8 parameter
      const matchUtf8 = header.match(/filename\*=UTF-8''(.+)$/);
      expect(matchUtf8).not.toBeNull();
      expect(decodeURIComponent(matchUtf8![1])).toBe('رخصة المحجر.pdf');
    });

    it('2. formats Arabic filename with spaces and Arabic numerals', () => {
      const header = buildContentDisposition('عقد توريد محجر ٢٠٢٦.pdf');
      expect(header).toContain('filename="document.pdf"');
      expect(header).toContain("filename*=UTF-8''");
      const matchUtf8 = header.match(/filename\*=UTF-8''(.+)$/);
      expect(decodeURIComponent(matchUtf8![1])).toBe('عقد توريد محجر ٢٠٢٦.pdf');
    });

    it('3. formats mixed Arabic and English preserving alphanumeric ASCII in fallback', () => {
      const header = buildContentDisposition('Quarry_رخصة_2026.pdf');
      expect(header).toContain('filename="Quarry__2026.pdf"');
      const matchUtf8 = header.match(/filename\*=UTF-8''(.+)$/);
      expect(decodeURIComponent(matchUtf8![1])).toBe('Quarry_رخصة_2026.pdf');
    });

    it('4. strictly percent-encodes parentheses, single quotes, and asterisks per RFC 5987 attr-char', () => {
      const header = buildContentDisposition("رخصة (المحجر) 'خاص' *1*.pdf");
      // Check parentheses are %28 and %29, quote is %27, asterisk is %2A
      expect(header).toContain('%28');
      expect(header).toContain('%29');
      expect(header).toContain('%27');
      expect(header).toContain('%2A');
      // Ensure no raw parentheses, quotes, or asterisks in the filename* portion
      const utf8Part = header.split("filename*=UTF-8''")[1];
      expect(utf8Part).not.toMatch(/['()*]/);
      expect(decodeURIComponent(utf8Part)).toBe("رخصة (المحجر) 'خاص' *1*.pdf");
    });

    it('5. formats pure English filename cleanly', () => {
      const header = buildContentDisposition('geological_report_2026.pdf');
      expect(header).toBe(
        'attachment; filename="geological_report_2026.pdf"; filename*=UTF-8\'\'geological_report_2026.pdf'
      );
    });

    it('6. safely handles filenames without extension, empty strings, and control characters', () => {
      const emptyHeader = buildContentDisposition('');
      expect(emptyHeader).toBe('attachment; filename="document"; filename*=UTF-8\'\'document');

      const ctrlHeader = buildContentDisposition('bad\r\n\tfilename.pdf');
      expect(ctrlHeader).not.toMatch(/[\r\n\t]/);
      expect(ctrlHeader).toContain('filename="bad   filename.pdf"');
    });

    it('7. strictly handles Arabic with parentheses and Arabic-Indic numerals', () => {
      // Arabic-Indic numeral ١ is \u0661, encoded as %D9%A1
      const header = buildContentDisposition('رخصة المحجر (١).pdf');
      expect(header).toContain('filename="document.pdf"');
      expect(header).toContain('%28');
      expect(header).toContain('%29');
      expect(header).toContain('%D9%A1');
      const utf8Part = header.split("filename*=UTF-8''")[1];
      expect(decodeURIComponent(utf8Part)).toBe('رخصة المحجر (١).pdf');
    });

    it('8. strictly handles filenames with percent signs, apostrophes, and spaces', () => {
      const header = buildContentDisposition("تقرير 100% 'خاص' المحجر.pdf");
      // % must be %25, ' must be %27
      expect(header).toContain('%25');
      expect(header).toContain('%27');
      const utf8Part = header.split("filename*=UTF-8''")[1];
      expect(utf8Part).not.toContain("'");
      expect(decodeURIComponent(utf8Part)).toBe("تقرير 100% 'خاص' المحجر.pdf");
    });
  });

  describe('sanitizeFilename multipart normalization unit tests', () => {
    it('9. preserves ordinary ASCII filenames without corruption or alteration', () => {
      expect(sanitizeFilename('daily_report_2026.pdf')).toBe('daily_report_2026.pdf');
      expect(sanitizeFilename('Contract_v2.DOCX')).toBe('Contract_v2.DOCX');
      expect(sanitizeFilename('site map 01.png')).toBe('site map 01.png');
      expect(sanitizeFilename('report-final_v1.0.pdf')).toBe('report-final_v1.0.pdf');
    });

    it('10. normalizes Busboy Latin-1 misparsed UTF-8 bytes back to intact Arabic', () => {
      const arabicName = 'رخصة المحجر (١).pdf';
      const latin1Mojibake = Buffer.from(arabicName, 'utf8').toString('latin1');
      expect(latin1Mojibake).not.toBe(arabicName);
      expect(sanitizeFilename(latin1Mojibake)).toBe(arabicName);
    });

    it('11. preserves already valid UTF-8 Arabic and mixed filenames', () => {
      expect(sanitizeFilename('رخصة المحجر (١).pdf')).toBe('رخصة المحجر (١).pdf');
      expect(sanitizeFilename('Quarry_رخصة_2026.pdf')).toBe('Quarry_رخصة_2026.pdf');
    });
  });

  describe('End-to-End Download HTTP Endpoint with Arabic Filenames', () => {
    it('7. uploads and downloads document with Arabic filename and returns RFC 6266 / RFC 5987 headers', async () => {
      const company = await createTestCompany();
      const user = await createTestUser();
      await createTestMembership(user._id, company._id, MembershipRole.employee);
      const quarry = await createTestQuarry(company._id);
      await createTestPermission(user._id, quarry._id, {
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: false,
      });

      const authHeader = generateAuthHeader(user);
      const arabicFilename = 'رخصة المحجر 2026.pdf';
      const fileContent = Buffer.from('%PDF-1.4 Arabic Content Test %%%');

      // Upload document with Arabic filename
      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(authHeader)
        .set('Idempotency-Key', `idem-ar-${Date.now()}`)
        .field('display_name', 'رخصة تشغيل المحجر')
        .attach('file', fileContent, arabicFilename);

      expect(uploadRes.status).toBe(201);
      const documentId = uploadRes.body.id;
      expect(uploadRes.body.original_filename).toBe(arabicFilename);

      // Download document
      const downloadRes = await request(app)
        .get(`/documents/${documentId}/download`)
        .set(authHeader)
        .expect(200);

      const contentDisposition = downloadRes.headers['content-disposition'];
      expect(contentDisposition).toBeDefined();

      // Verify safe ASCII fallback
      expect(contentDisposition).toContain('filename="2026.pdf"');

      // Verify RFC 5987 encoded UTF-8
      const encodedExpected = encodeURIComponent(arabicFilename);
      expect(contentDisposition).toContain(`filename*=UTF-8''${encodedExpected}`);

      // Verify response body matches uploaded content
      expect(downloadRes.body).toEqual(fileContent);
    });

    it('8. downloads document with Arabic filename containing parentheses without mangling', async () => {
      const company = await createTestCompany();
      const user = await createTestUser();
      await createTestMembership(user._id, company._id, MembershipRole.employee);
      const quarry = await createTestQuarry(company._id);
      await createTestPermission(user._id, quarry._id, {
        can_view: true,
        can_upload: true,
        can_download: true,
        can_delete: false,
      });

      const authHeader = generateAuthHeader(user);
      const arabicWithParens = 'تقرير (فني) معتمد.pdf';
      const fileContent = Buffer.from('%PDF-1.4 Technical Report with Parentheses');

      const uploadRes = await request(app)
        .post(`/quarries/${quarry._id}/documents`)
        .set(authHeader)
        .set('Idempotency-Key', `idem-parens-${Date.now()}`)
        .field('display_name', 'تقرير فني معتمد')
        .attach('file', fileContent, arabicWithParens);

      expect(uploadRes.status).toBe(201);
      const documentId = uploadRes.body.id;

      const downloadRes = await request(app)
        .get(`/documents/${documentId}/download`)
        .set(authHeader)
        .expect(200);

      const cd = downloadRes.headers['content-disposition'];
      expect(cd).toBeDefined();
      // Parentheses must be encoded as %28 and %29 in filename*
      expect(cd).toContain('%28');
      expect(cd).toContain('%29');
      // Must not contain raw '(' or ')' in filename*
      const utf8Part = cd.split("filename*=UTF-8''")[1];
      expect(utf8Part).not.toContain('(');
      expect(utf8Part).not.toContain(')');
      expect(decodeURIComponent(utf8Part)).toBe(arabicWithParens);
    });
  });
});
