"""Build only fabricated OCR acceptance fixtures; no user files are accepted.
Usage: python generate.py /absolute/output/directory
Requires reportlab, Pillow, pypdf[crypto].
"""
import io, json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import reportlab
from pypdf import PdfReader, PdfWriter

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
font_path = Path(reportlab.__file__).parent / 'fonts' / 'Vera.ttf'
manifest = []

def raster(lines, small=False):
    image = Image.new('RGB', (1224, 1584), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 14 if small else 26)
    for i, line in enumerate(lines):
        draw.text((108, 150 + i * (23 if small else 58)), line, font=font, fill='black')
    return image

def make(name, lines, small=False, mixed=False, rotate=False):
    dest = out / f'{name}.pdf'
    c = canvas.Canvas(str(dest), pagesize=(612,792), invariant=True)
    c.setTitle('SYNTHETIC OCR ACCEPTANCE - NOT A REAL TAX RECORD')
    c.drawImage(ImageReader(raster(lines, small)), 0, 0, width=612, height=792)
    if mixed:
        c.setFont('Helvetica',16)
        c.drawString(54,760,'MIXED TEXT LAYER: CEDAR-4826')
    c.showPage(); c.save()
    if rotate:
        writer = PdfWriter(); writer.clone_document_from_reader(PdfReader(dest))
        writer.pages[0].rotate(90)
        with dest.open('wb') as f: writer.write(f)
    manifest.append({'name':name,'file':dest.name,'expected':lines + (['MIXED TEXT LAYER: CEDAR-4826'] if mixed else []), 'kind':'scan' if not mixed else 'mixed'})

base = ['SYNTHETIC OCR TEST - NOT A REAL TAX RECORD', 'Fixture: CEDAR-4826', 'Tax year: 2025',
        'Gross amount: $12,345.67', 'Deduction: $890.12', 'Net amount: $11,455.55',
        'Payment date: 2025-12-31', '[X] Resident   [ ] Nonresident']
make('scan',base)
make('rotated',base,rotate=True)
make('mixed',base,mixed=True)
make('small-print',base+['Small print: 0.01  1,001.10  10,010.01  -42.50'],small=True)
make('multilingual',['SYNTHETIC OCR TEST - FICTIONAL VALUES','Name: Anna Müller','Reçu: déjà payé','Betrag: 1.234,56 EUR','Référence: ÉTÉ-2025'])
# Real widgets, with generated appearance streams and independent /V checks.
dest=out/'forms.pdf'
c=canvas.Canvas(str(dest), pagesize=(612,792), invariant=True)
c.setFont('Helvetica',14);c.drawString(54,740,'SYNTHETIC FORM - FICTIONAL VALUES')
f=c.acroForm
for name,label,value,y in [('entity','Entity','CEDAR TEST LLC',680),('amount','Gross amount','12345.67',630)]:
    c.setFont('Helvetica',11);c.drawString(54,y+6,label)
    f.textfield(name=name,value=value,x=170,y=y,width=250,height=26,fontSize=12)
f.checkbox(name='resident',checked=True,x=54,y=580,buttonStyle='check');c.drawString(82,585,'Resident')
f.checkbox(name='nonresident',checked=False,x=210,y=580,buttonStyle='check');c.drawString(238,585,'Nonresident')
f.choice(name='category',value='Business',options=['Personal','Business'],x=170,y=520,width=200,height=26)
c.drawString(54,528,'Category')
c.showPage();c.save()
fields=PdfReader(dest).get_fields()
expected_fields={'entity':'CEDAR TEST LLC','amount':'12345.67','resident':'/Yes','nonresident':'/Off','category':'Business'}
assert all(str(fields[k]['/V'])==v for k,v in expected_fields.items())
manifest.append({'name':'forms','file':dest.name,'expected':['SYNTHETIC FORM','CEDAR TEST LLC','12345.67','[X] Resident','[ ] Nonresident','Business'],'fields':expected_fields,'kind':'form'})
writer=PdfWriter();writer.clone_document_from_reader(PdfReader(out/'scan.pdf'))
writer.encrypt('synthetic-open-password', owner_password='synthetic-owner-password', algorithm='AES-256')
writer.write(out/'encrypted-scan.pdf')
manifest.append({'name':'encrypted-scan','file':'encrypted-scan.pdf','expected':base,'kind':'scan','password':'synthetic-open-password'})
(out/'manifest.json').write_text(json.dumps({'syntheticOnly':True,'cases':manifest},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(out),'cases':len(manifest)}))
