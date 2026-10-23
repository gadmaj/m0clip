#!/usr/bin/env python3
"""Require g's selected SSH key and expose xrdp only inside an SSH tunnel.
Run with sudo. A client must confirm successful fresh-key/tunnel checks within
180 seconds or the original server configuration is restored automatically.
"""
import grp,json,os,pwd,re,shutil,subprocess,sys,time
from pathlib import Path

ACCOUNT='g'
FINGERPRINT='SHA256:RVS64kvY51Rr67R8f0klNTyp865bjoGXUklqLVf8aYU'
BEGIN='# BEGIN UNITREE DEVICE KEY'
END='# END UNITREE DEVICE KEY'

def run(*args):
    return subprocess.run(args,check=True,capture_output=True,text=True).stdout

def update_section(text,section,changes):
    current=None;seen=set();output=[]
    for line in text.splitlines(keepends=True):
        match=re.match(r'\s*\[([^]]+)\]',line)
        if match:current=match.group(1)
        if current==section:
            match=re.match(r'\s*([^;#=]+?)\s*=',line)
            if match and match.group(1) in changes:
                key=match.group(1);seen.add(key);line=f'{key}={changes[key]}\n'
        output.append(line)
    if seen!=set(changes):raise RuntimeError(f'Missing settings in {section}: {set(changes)-seen}')
    return ''.join(output)

def main():
    if os.geteuid()!=0:raise RuntimeError('Run this setup with sudo')
    user=pwd.getpwnam(ACCOUNT);home=Path(user.pw_dir)
    state=home/'.local/state/unitree-access';state.mkdir(parents=True,exist_ok=True)
    key=home/'.ssh/unitree-device-authorized_keys'
    if FINGERPRINT not in run('ssh-keygen','-lf',str(key)):raise RuntimeError('Unexpected device key')
    if len([line for line in key.read_text().splitlines() if line.strip() and not line.startswith('#')])!=1:raise RuntimeError('Exactly one device key is required')
    commit=state/'access-validated';ready=state/'access-applied.json';result=state/'access-result.json'
    for path in (commit,ready,result):path.unlink(missing_ok=True)
    sources=[Path('/etc/ssh/sshd_config'),Path('/etc/xrdp/xrdp.ini'),Path('/etc/xrdp/sesman.ini')]
    backup=Path('/var/backups/unitree-device-access')/time.strftime('%Y%m%dT%H%M%S')
    backup.mkdir(parents=True,mode=0o700)
    old={path:path.read_bytes() for path in sources}
    for path in sources:shutil.copy2(path,backup/path.name)
    created_group=False;added_member=False;changed=False
    def save(path,value):
        path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o644)
    def rollback():
        for path,data in old.items():path.write_bytes(data)
        run('/usr/sbin/sshd','-t');run('systemctl','reload','ssh')
        run('systemctl','restart','xrdp-sesman','xrdp')
        if added_member:run('gpasswd','-d',ACCOUNT,'unitree-desktop')
        if created_group:run('groupdel','unitree-desktop')
    try:
        try:group=grp.getgrnam('unitree-desktop')
        except KeyError:
            run('groupadd','--system','unitree-desktop');created_group=True;group=grp.getgrnam('unitree-desktop')
        if any(member!=ACCOUNT for member in group.gr_mem):raise RuntimeError('Desktop access group has unexpected members')
        if ACCOUNT not in group.gr_mem:run('usermod','-a','-G','unitree-desktop',ACCOUNT);added_member=True
        ssh=old[sources[0]].decode()
        ssh=re.sub(re.escape(BEGIN)+r'.*?'+re.escape(END)+r'\n?','',ssh,flags=re.S)
        ssh+=f'\n{BEGIN}\nMatch User {ACCOUNT}\n    AuthenticationMethods publickey\n    PubkeyAuthentication yes\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    AuthorizedKeysFile .ssh/unitree-device-authorized_keys\n{END}\n'
        sources[0].write_text(ssh);changed=True
        sources[1].write_text(update_section(old[sources[1]].decode(),'Globals',{'port':'tcp://127.0.0.1:3389'}))
        sources[2].write_text(update_section(old[sources[2]].decode(),'Security',{'AllowRootLogin':'false','TerminalServerUsers':'unitree-desktop','AlwaysGroupCheck':'true'}))
        run('/usr/sbin/sshd','-t')
        effective=run('/usr/sbin/sshd','-T','-C',f'user={ACCOUNT},host=gdev-kubu,addr=192.168.20.155')
        for setting in ('authenticationmethods publickey','passwordauthentication no','kbdinteractiveauthentication no','authorizedkeysfile .ssh/unitree-device-authorized_keys'):
            if setting not in effective.splitlines():raise RuntimeError('Effective SSH setting differs: '+setting)
        run('systemctl','reload','ssh')
        run('systemctl','restart','xrdp-sesman','xrdp')
        save(ready,{'state':'awaiting-client-validation','backup':str(backup),'fingerprint':FINGERPRINT})
        print('Device-key SSH and loopback RDP applied. Waiting for fresh client verification.',flush=True)
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            if commit.is_file() and commit.stat().st_uid==user.pw_uid and commit.read_text().strip()=='validated':
                save(result,{'state':'verified','backup':str(backup),'fingerprint':FINGERPRINT})
                print('Fresh client verification passed; configuration retained.',flush=True)
                return
            time.sleep(1)
        raise RuntimeError('Client verification did not complete in 180 seconds')
    except BaseException as error:
        if changed or created_group or added_member:rollback()
        save(result,{'state':'rolled-back','reason':str(error),'backup':str(backup)})
        raise

if __name__=='__main__':main()
