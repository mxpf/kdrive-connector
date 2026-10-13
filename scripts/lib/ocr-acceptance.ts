// Phrase matching is a conservative automated gate; visual review must also
// check omissions and invented content. Keep digits, punctuation and marks.
export function missingOcrText(expected: string[], actual: string): string[] {
  const normalize = (text: string) => text.normalize('NFC').replace(/[\s*`]+/g, ' ').trim().toLowerCase();
  const transcription = normalize(actual);
  return expected.filter(line => !transcription.includes(normalize(line)));
}
