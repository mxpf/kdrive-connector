"""Independent parser assertions on the bytes received by the HTTP clients."""
import sys
from pypdf import PdfReader
from pypdf.errors import FileNotDecryptedError

reader = PdfReader(sys.argv[1], strict=True)
if sys.argv[2] == 'encrypted':
    assert reader.is_encrypted
    assert reader.decrypt('incorrect-password') == 0
    try:
        reader.pages[0].extract_text()
        raise AssertionError('Encrypted content was available without the password')
    except FileNotDecryptedError:
        pass
    assert reader.decrypt('synthetic-open-password') != 0
else:
    assert not reader.is_encrypted
assert len(reader.pages) == 1
assert 'Verification phrase: ORCHID-7319' in reader.pages[0].extract_text()
print('PDF parsed; expected text verified')
