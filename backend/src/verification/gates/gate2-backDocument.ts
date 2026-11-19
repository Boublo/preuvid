/**
 * Gate 2 — Back Document Integrity
 *
 * FAIL if:
 *   - US document: No barcode found (qr_payload is null) AND no MRZ
 *   - Non-US document: Neither barcode NOR MRZ found
 *   - MRZ checksums failed (checksums_valid === false). Preuvid (lot 1) splits this case:
 *       BACK_MRZ_CHECKSUM_FAILED — a field whose own check digit is wrong carries the same value
 *         as the front, read independently: the document itself is inconsistent;
 *       BACK_MRZ_UNREADABLE — otherwise: an OCR misread (dark or noisy photo) is the likelier
 *         cause, so the user is asked for a new photo rather than told the ID looks altered.
 *   - Front MRZ and back MRZ disagree (BACK_MRZ_BARCODE_MISMATCH)
 *
 * PASS if:
 *   - Barcode decoded and all MRZ checks pass, OR
 *   - Non-US document with valid MRZ (barcode not required)
 */

import { parse as parseMRZ } from 'mrz';
import type { BackExtractionResult, FrontExtractionResult, GateResult } from '@idswyft/shared';

/** MRZ fields protected by their own check digit, and the front OCR field holding the same value. */
const KEYED_FIELDS = {
  documentNumber: ['id_number', 'document_number'],
  birthDate: ['date_of_birth'],
  expirationDate: ['expiry_date', 'expiration_date'],
} as const;

const compact = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** ISO date (YYYY-MM-DD) to the MRZ form YYMMDD; anything else gives null (no evidence). */
function isoToMrzDate(v: unknown): string | null {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1].slice(2) + m[2] + m[3] : null;
}

/**
 * MRZ fields whose own check digit is wrong although the front, read separately, shows the same
 * value. Two independent reads agreeing on a value whose key is wrong point at the document, not
 * at the OCR. A front whose values may come from an MRZ of its own is not independent: no evidence.
 */
export function keyFailuresConfirmedByFront(rawLines: string[], front: FrontExtractionResult): string[] {
  if (front.mrz_from_front && front.mrz_from_front.length > 0) return [];
  let details;
  try {
    details = parseMRZ(rawLines, { autocorrect: false } as any).details;
  } catch {
    return [];
  }
  const ocr = (front.ocr ?? {}) as Record<string, unknown>;
  const confirmed: string[] = [];
  for (const [field, frontKeys] of Object.entries(KEYED_FIELDS)) {
    const key = details.find(d => d.field === `${field}CheckDigit`);
    const value = details.find(d => d.field === field)?.value;
    if (!key || key.valid || !value) continue;
    const isDate = field !== 'documentNumber';
    const agrees = frontKeys.some(k => {
      if (ocr[k] == null || ocr[k] === '') return false;
      return isDate ? isoToMrzDate(ocr[k]) === value : compact(ocr[k]) === compact(value);
    });
    if (agrees) confirmed.push(field);
  }
  return confirmed;
}

export function evaluateGate2(
  back: BackExtractionResult,
  front: FrontExtractionResult,
  issuingCountry?: string | null,
): GateResult {
  const isUS = !issuingCountry || issuingCountry === 'US';
  const hasBarcode = !!(back.qr_payload || back.barcode_format);
  const hasMRZ = !!(back.mrz_result && back.mrz_result.raw_lines.length > 0);
  const isMRZFormat = back.barcode_format?.startsWith('MRZ_');

  // Check barcode/MRZ presence
  if (!hasBarcode && !hasMRZ && !isMRZFormat) {
    if (isUS) {
      // US documents require a barcode (PDF417)
      return {
        passed: false,
        rejection_reason: 'BACK_BARCODE_NOT_FOUND',
        rejection_detail: 'No barcode (PDF417, QR, DataMatrix) detected on back of document',
        user_message: 'We could not read the barcode on the back of your ID. Please retake the photo ensuring the barcode is clearly visible.',
      };
    } else {
      // Non-US: accept MRZ as alternative, but fail if neither found
      return {
        passed: false,
        rejection_reason: 'BACK_BARCODE_NOT_FOUND',
        rejection_detail: 'No barcode or MRZ detected on back of document',
        user_message: 'We could not read the barcode or machine-readable zone on the back of your ID. Please retake the photo ensuring the back is clearly visible.',
      };
    }
  }

  // Check MRZ checksums if present
  if (back.mrz_result && !back.mrz_result.checksums_valid) {
    const confirmed = keyFailuresConfirmedByFront(back.mrz_result.raw_lines, front);
    if (confirmed.length > 0) {
      return {
        passed: false,
        rejection_reason: 'BACK_MRZ_CHECKSUM_FAILED',
        rejection_detail: `MRZ check digit wrong for ${confirmed.join(', ')} although the front shows the same value — possible physical tampering`,
        user_message: 'We detected an issue with your document. Please ensure you are using an original, unaltered ID.',
      };
    }
    return {
      passed: false,
      rejection_reason: 'BACK_MRZ_UNREADABLE',
      rejection_detail: 'MRZ check digits failed and the front does not confirm the values read — most likely an OCR misread',
      user_message: 'We could not read the machine-readable zone on the back of your ID reliably. Please retake the photo in good lighting, without glare, with the whole back visible.',
    };
  }

  // Check front MRZ vs back MRZ consistency
  if (front.mrz_from_front && front.mrz_from_front.length > 0 && back.mrz_result) {
    const frontMrzJoined = front.mrz_from_front.join('').replace(/[^A-Z0-9<]/g, '');
    const backMrzJoined = back.mrz_result.raw_lines.join('').replace(/[^A-Z0-9<]/g, '');

    if (frontMrzJoined !== backMrzJoined) {
      return {
        passed: false,
        rejection_reason: 'BACK_MRZ_BARCODE_MISMATCH',
        rejection_detail: `Front MRZ does not match back MRZ — strong fraud signal`,
        user_message: 'The front and back of your document do not appear to match. Please ensure both images are from the same ID.',
      };
    }
  }

  return {
    passed: true,
    rejection_reason: null,
    rejection_detail: null,
    user_message: null,
  };
}
