#!/usr/bin/env python3
from pathlib import Path
import grp,os,re,subprocess,socket,ssl,hashlib,shutil,time
p=Path('/etc/xrdp/xrdp.ini');before=p.read_bytes()
backup=Path('/var/backups/unitree-device-access')/('tls-'+time.strftime('%Y%m%dT%H%M%S'));backup.mkdir(mode=0o700)
shutil.copy2(p,backup/p.name)
key=Path('/etc/xrdp/unitree-desktop-key.pem');cert=Path('/etc/xrdp/unitree-desktop-cert.pem')
if not key.exists():
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','825','-subj','/CN=gdev-kubu','-addext','subjectAltName=DNS:gdev-kubu,IP:127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.chown(key,0,grp.getgrnam('xrdp').gr_gid);key.chmod(0o640);cert.chmod(0o644)
current=None;lines=[];seen=set();changes={'security_layer':'tls','certificate':str(cert),'key_file':str(key)}
for line in before.decode().splitlines(keepends=True):
 section=re.match(r'\s*\[([^]]+)\]',line)
 if section:current=section.group(1)
 if current=='Globals':
  match=re.match(r'\s*([^;#=]+?)\s*=',line)
  if match and match.group(1) in changes:
   name=match.group(1);seen.add(name);line=name+'='+changes[name]+'\n'
 lines.append(line)
if seen!=set(changes):raise RuntimeError('Expected xrdp TLS settings are missing')
try:
 p.write_text(''.join(lines));subprocess.run(['systemctl','restart','xrdp'],check=True)
 deadline=time.monotonic()+15
 while True:
  try:
   connection=socket.create_connection(('127.0.0.1',3389),timeout=5);break
  except OSError:
   if time.monotonic()>=deadline:raise
   time.sleep(.2)
 with connection:
  connection.sendall(bytes.fromhex('030000130ee000000000000100080003000000'));reply=connection.recv(1024)
  if reply[11]!=2 or int.from_bytes(reply[15:19],'little')!=1:raise RuntimeError('Desktop did not negotiate TLS')
  context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.check_hostname=False;context.verify_mode=ssl.CERT_NONE
  with context.wrap_socket(connection,server_hostname='gdev-kubu') as encrypted:
   print('Desktop TLS verified:',encrypted.version(),hashlib.sha256(encrypted.getpeercert(binary_form=True)).hexdigest())
except BaseException:
 p.write_bytes(before);subprocess.run(['systemctl','restart','xrdp'],check=True);raise
