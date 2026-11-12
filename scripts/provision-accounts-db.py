"""Create the dedicated account database and apply idempotent schema additions."""
import argparse, json, os, urllib.request
from pathlib import Path
API='https://api.cloudflare.com/client/v4/accounts/becd45ae768351f6a81f1c51f7e7528b/d1/database'
def request(url,data=None):
    req=urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+os.environ['CLOUDFLARE_API_TOKEN'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as response: result=json.load(response)
    if not result.get('success'): raise RuntimeError('Database operation failed')
    return result['result']
parser=argparse.ArgumentParser()
parser.add_argument('--existing', help='Exact existing database name explicitly selected by the owner')
args=parser.parse_args()
name=args.existing or 'kwest-fit-users'
existing=next((item for item in request(API) if item['name']==name),None)
if args.existing and existing is None: raise RuntimeError('Selected existing database not found')
database=existing or request(API,{'name':name})
database_id=database['uuid']
schema=request(API+'/'+database_id+'/query',{'sql':"SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fit_*'"})[0]['results']
if schema:
    if not any(row['name']=='fit_account_schema' for row in schema):
        raise RuntimeError('The fit_* namespace is already occupied; choose another database')
    marker=request(API+'/'+database_id+'/query',{'sql':"SELECT version FROM fit_account_schema WHERE namespace='kwest.fit.accounts'"})[0]['results']
    if not marker or marker[0]['version']!=1: raise RuntimeError('Unknown account schema version; refusing to change it')
request(API+'/'+database_id+'/query',{'sql':Path('worker/migrations/0001_accounts.sql').read_text()})
Path('production/accounts-database.json').write_text(json.dumps({'binding':'DB','name':name,'id':database_id},indent=2)+'\n')
print('Account database ready:',database_id)
