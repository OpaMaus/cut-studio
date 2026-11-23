import hashlib,json,pathlib,shutil,stat,zipfile,sys
archive=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'source.zip')
dest=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'source').resolve()
assert not dest.exists(), 'Use a fresh source directory'
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None, 'Source archive checksum failure'
    manifests=[e.filename for e in z.infolist() if pathlib.PurePosixPath(e.filename).name=='FILES-SHA256.json']
    assert len(manifests)==1, 'Exactly one source inventory required'
    prefix=manifests[0][:-len('FILES-SHA256.json')]
    seen=set()
    for e in z.infolist():
        assert e.filename.startswith(prefix), 'Mixed archive roots'
        relative=e.filename[len(prefix):]
        if not relative:continue
        pure=pathlib.PurePosixPath(relative)
        assert not pure.is_absolute() and '..' not in pure.parts and '\\' not in relative and ':' not in relative, 'Unsafe source path'
        assert not stat.S_ISLNK(e.external_attr>>16), 'Source links not allowed'
        target=dest.joinpath(*pure.parts).resolve()
        assert target.is_relative_to(dest), 'Source path escapes destination'
        if e.is_dir():target.mkdir(parents=True,exist_ok=True);continue
        assert relative not in seen, 'Duplicate source entry'
        seen.add(relative);target.parent.mkdir(parents=True,exist_ok=True)
        with z.open(e) as source,target.open('wb') as out:shutil.copyfileobj(source,out)
        mode=(e.external_attr>>16)&0o777
        if mode:target.chmod(mode)
inventory=json.loads((dest/'FILES-SHA256.json').read_text())
assert seen=={entry['path'] for entry in inventory}|{'FILES-SHA256.json'}, 'Unlisted source files'
for entry in inventory:
    file=dest/entry['path']
    assert file.resolve().is_relative_to(dest)
    data=file.read_bytes()
    assert len(data)==entry['bytes'] and hashlib.sha256(data).hexdigest()==entry['sha256'], 'Source inventory mismatch'
assert (dest/'build-macos.mjs').is_file(), 'Mac build entrypoint missing'
print(json.dumps({'sourceReady':True,'verifiedFiles':len(inventory)}))
