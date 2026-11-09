"""Deploy prepared brand assets while retaining production Worker modules and bindings."""
import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import subprocess
from email.parser import BytesParser
from email.policy import default
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / 'artifacts/visual-release'
API = 'https://api.cloudflare.com/client/v4'
ACCOUNT = 'becd45ae768351f6a81f1c51f7e7528b'
WORKER = f'/accounts/{ACCOUNT}/workers/scripts/smart-fit'
TOKEN = os.environ['CLOUDFLARE_API_TOKEN']
BACKUP = ROOT / 'artifacts/visual-deploy'
BACKUP.mkdir(parents=True, exist_ok=True)


def request(path, method='GET', data=None, token=TOKEN, content_type=None, raw=False):
    headers = {'Authorization': 'Bearer ' + token}
    if isinstance(data, dict):
        data = json.dumps(data).encode()
        content_type = 'application/json'
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            body = response.read()
            if raw:
                return body, response.headers['Content-Type']
    except urllib.error.HTTPError as error:
        # Never log upload JWTs, secret values, or authorization headers.
        try:
            errors = json.load(error).get('errors', [])
            codes = [(e.get('code'), str(e.get('message', ''))[:1000]) for e in errors]
        except Exception:
            codes = []
        raise RuntimeError(f'Cloudflare {method} {path}: HTTP {error.code}, codes {codes}') from None
    result = json.loads(body)
    if not result.get('success'):
        raise RuntimeError('Cloudflare rejected request: ' + str([e.get('code') for e in result.get('errors', [])]))
    return result['result']


def multipart(items):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, data, content_type, filename in items:
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        body.extend(f'--{boundary}\r\n{disposition}\r\nContent-Type: {content_type}\r\n\r\n'.encode())
        body.extend(data)
        body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    return bytes(body), 'multipart/form-data; boundary=' + boundary


# Match Wrangler's asset hash algorithm.
node = """
const fs=require('fs'),path=require('path'),blake=require('blake3-wasm');
const root=process.argv[1], manifest={};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else{
 const bytes=fs.readFileSync(file),key='/'+path.relative(root,file).split(path.sep).join('/');
 manifest[key]={hash:blake.hash(bytes.toString('base64')+path.extname(file).slice(1)).toString('hex').slice(0,32),size:bytes.length};
}}}walk(root);process.stdout.write(JSON.stringify(manifest));
"""
manifest = json.loads(subprocess.check_output(['node', '-e', node, str(RELEASE)], cwd=ROOT))
assert '/index.html' in manifest and '/logo.svg' in manifest
settings = request(WORKER + '/settings')
deployment = request(WORKER + '/deployments')['deployments'][0]
version = request(WORKER + '/versions/' + deployment['versions'][0]['version_id'])
source, content_type = request(WORKER, raw=True)
(BACKUP / 'worker.multipart').write_bytes(source)
(BACKUP / 'worker-content-type.txt').write_text(content_type)
(BACKUP / 'settings.json').write_text(json.dumps(settings, indent=2))
(BACKUP / 'deployment.json').write_text(json.dumps(deployment, indent=2))
print('Saved rollback deployment:', deployment['id'], flush=True)

session = request(WORKER + '/assets-upload-session', 'POST', {'manifest': manifest})
completion = session['jwt'] if not session['buckets'] else None
by_hash = {value['hash']: path for path, value in manifest.items()}
claims = json.loads(base64.urlsafe_b64decode(session['jwt'].split('.')[1] + '==='))
for bucket in session['buckets']:
    if claims.get('wrangler_single_asset_uploads'):
        for asset_hash in bucket:
            path = by_hash[asset_hash]
            data = (RELEASE / path.lstrip('/')).read_bytes()
            result = request(f'/accounts/{ACCOUNT}/workers/assets/upload/{asset_hash}', 'POST', data, session['jwt'], mimetypes.guess_type(path)[0] or 'application/octet-stream')
            completion = result.get('jwt') or completion
    else:
        items = []
        for asset_hash in bucket:
            path = by_hash[asset_hash]
            items.append((asset_hash, base64.b64encode((RELEASE / path.lstrip('/')).read_bytes()), mimetypes.guess_type(path)[0] or 'application/octet-stream', asset_hash))
        data, content_type_upload = multipart(items)
        result = request(f'/accounts/{ACCOUNT}/workers/assets/upload?base64=true', 'POST', data, session['jwt'], content_type_upload)
        completion = result.get('jwt') or completion
    print('Uploaded asset bucket:', len(bucket), 'files', flush=True)
assert completion, 'Asset upload did not return completion token'

# Refuse to overwrite another deployment made while assets were uploading.
assert request(WORKER + '/deployments')['deployments'][0]['id'] == deployment['id'], 'Production changed during upload'
message = BytesParser(policy=default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode() + source)
parts = list(message.iter_parts())
script = next(p for p in parts if b'redirect: "manual"' in p.get_payload(decode=True) and b'async function stravaHandler' in p.get_payload(decode=True))
asset_config = version['resources']['script_runtime']['assets']
metadata = {
    'main_module': script.get_param('name', header='content-disposition') or script.get_filename() or 'index.js',
    'compatibility_date': settings['compatibility_date'],
    'compatibility_flags': settings.get('compatibility_flags', []),
    'bindings': [b for b in settings['bindings'] if b['type'] != 'secret_text'],
    'keep_bindings': ['secret_text'],
    'assets': {'jwt': completion, 'config': {
        'not_found_handling': asset_config.get('not_found_handling', 'single-page-application'),
        'run_worker_first': asset_config.get('raw_run_worker_first', True),
        'base_path': asset_config.get('base_path', '/'),
    }},
    'tags': settings.get('tags', []),
    'logpush': settings.get('logpush', False),
}
for key in ['observability', 'tail_consumers', 'placement', 'limits']:
    if settings.get(key):
        metadata[key] = settings[key]
items = [('metadata', json.dumps(metadata).encode(), 'application/json', None)]
for part in parts:
    name = part.get_param('name', header='content-disposition') or part.get_filename()
    module_type = 'application/javascript+module' if part is script else part.get_content_type()
    items.append((name, part.get_payload(decode=True), module_type, part.get_filename() or name))
data, upload_type = multipart(items)
request(WORKER, 'PUT', data, content_type=upload_type)
active = request(WORKER + '/deployments')['deployments'][0]
current, current_type = request(WORKER, raw=True)
current_message = BytesParser(policy=default).parsebytes(('Content-Type: ' + current_type + '\r\n\r\n').encode() + current)
assert any(p.get_payload(decode=True) == script.get_payload(decode=True) for p in current_message.iter_parts()), 'Worker source verification failed'
assert request(WORKER + '/settings')['bindings'] == settings['bindings'], 'Binding verification failed'
(BACKUP / 'published.json').write_text(json.dumps({'deployment': active, 'workerSha256': hashlib.sha256(script.get_payload(decode=True)).hexdigest()}, indent=2))
print('Published deployment:', active['id'])
print('Verified unchanged Worker source and bindings; static visual assets deployed.')
