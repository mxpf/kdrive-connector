"""One deterministic, image-only dense OCR fixture; accepts no source document."""
import sys, json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import reportlab

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
lines = ['SYNTHETIC DENSE OCR TEST - FICTIONAL DATA ONLY', 'Fixture: DENSE-6428; no real person or tax record.']
for row in range(1, 49):
    lines.append(f'Row {row:02d}: Reference CEDAR-{7000+row}; amount {100+row}.25; date 2025-12-31; status reviewed; entry confirmed.')
lines.append('END OF SYNTHETIC DENSE FIXTURE - VERIFY ALL 48 ROWS')
assert len('\n'.join(lines)) > 4000
image = Image.new('RGB', (1224, 1584), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype(str(Path(reportlab.__file__).parent / 'fonts' / 'Vera.ttf'), 22)
for index, line in enumerate(lines):
    assert draw.textlength(line, font=font) < 1144
    draw.text((40, 48+index*29), line, font=font, fill='black')
pdf = canvas.Canvas(str(out/'dense-scan.pdf'), pagesize=(612,792), invariant=True)
pdf.setTitle('SYNTHETIC DENSE OCR TEST - FICTIONAL DATA ONLY')
pdf.drawImage(ImageReader(image),0,0,width=612,height=792)
pdf.showPage();pdf.save()
(out/'dense-manifest.json').write_text(json.dumps({'syntheticOnly':True,'expected':lines},indent=2)+'\n')
