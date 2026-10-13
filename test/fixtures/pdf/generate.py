"""Regenerate synthetic fixtures; requires reportlab and pypdf[crypto].

Regeneration changes encrypted bytes/salts. Update README hashes after inspection.
"""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from pypdf import PdfReader, PdfWriter

root = Path(__file__).parent
pdf = canvas.Canvas(str(root / 'ordinary.pdf'), pagesize=letter,
                    invariant=True, pageCompression=0)
pdf.setTitle('kDrive synthetic interoperability fixture')
pdf.setAuthor('kDrive Connector tests')
pdf.setFont('Helvetica', 16)
pdf.drawString(54, 738, 'kDrive binary handoff regression fixture')
pdf.setFont('Helvetica', 11)
pdf.drawString(54, 710, 'Synthetic data only. No personal or financial records.')
pdf.drawString(54, 680, 'Verification phrase: ORCHID-7319')
pdf.showPage()
pdf.save()
writer = PdfWriter()
writer.clone_document_from_reader(PdfReader(root / 'ordinary.pdf'))
writer.encrypt('synthetic-open-password', owner_password='synthetic-owner-password',
               algorithm='AES-256')
writer.write(root / 'password-protected.pdf')
