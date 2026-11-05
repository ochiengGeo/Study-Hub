"""PowerPoint / Word → PDF on the laptop, with LibreOffice, so the phone can show slides and
documents in StudyHub's own PDF viewer (and AI cards / practice exams can read them).

Converted copies are cached in sync-data/converted/<file id>.pdf. Synced files never change
(a changed file is a new file), so a conversion is done once per file.
"""
import os
import shutil
import subprocess
import tempfile
import threading

SLIDE_EXT = {'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'key'}
OFFICE_EXT = SLIDE_EXT | {'doc', 'docx', 'odt', 'rtf'}
_lock = threading.Lock()   # LibreOffice runs one conversion at a time


def soffice():
    return shutil.which('soffice') or shutil.which('libreoffice')


def is_office(rec):
    return (rec.get('ext') or os.path.splitext(rec.get('name') or '')[1][1:]).lower() in OFFICE_EXT


def pdf_for(hub, rec):
    """Path of a PDF version of this file (converting it the first time), or raise RuntimeError."""
    out_dir = os.path.join(hub.dir, 'converted')
    out = os.path.join(out_dir, f"{rec['id']}.pdf")
    if os.path.exists(out):
        return out
    src = hub.blob_path(rec['id'])
    if not os.path.exists(src):
        raise RuntimeError("The laptop doesn't have this file yet. Sync first (🔄), then try again.")
    exe = soffice()
    if not exe:
        raise RuntimeError('LibreOffice is not installed on the laptop (sudo apt install libreoffice-impress)')
    ext = (rec.get('ext') or 'pptx').lower()
    os.makedirs(out_dir, exist_ok=True)
    with _lock, tempfile.TemporaryDirectory() as tmp:
        if os.path.exists(out):
            return out
        inp = os.path.join(tmp, f'file.{ext}')
        shutil.copyfile(src, inp)   # LibreOffice needs the right extension
        profile = os.path.join(tmp, 'profile')   # own profile: works even while LibreOffice is open on the desktop
        try:
            subprocess.run([exe, f'-env:UserInstallation=file://{profile}', '--headless', '--norestore',
                            '--convert-to', 'pdf', '--outdir', tmp, inp],
                           capture_output=True, timeout=240, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Converting took too long') from None
        res = os.path.join(tmp, 'file.pdf')
        if not os.path.exists(res) or os.path.getsize(res) == 0:
            raise RuntimeError("LibreOffice couldn't convert this file")
        shutil.move(res, out + '.part')
        os.replace(out + '.part', out)
    return out
