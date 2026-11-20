import { describe, expect, it, vi } from 'vitest';
import { PaddleOCRProvider } from './PaddleOCRProvider.js';

describe('PaddleOCRProvider', () => {
  it("lit chaque image sans le cache de ppu-paddle-ocr", async () => {
    const recognize = vi.fn().mockResolvedValue({ text: '', lines: [], confidence: 0 });
    const provider = new PaddleOCRProvider();
    // Service factice : les modèles ne sont pas chargés dans ce test.
    (provider as any).service = { recognize };

    await provider.processDocument(Buffer.from([1, 2, 3]), 'national_id', 'FR');
    await provider.processDocument(Buffer.from([1, 2, 3]), 'national_id', 'FR');

    expect(recognize).toHaveBeenCalledTimes(2);
    for (const call of recognize.mock.calls) expect(call[1]).toEqual({ noCache: true });
  });
});
