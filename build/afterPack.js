// Puts the app's name, icon and version into MyVloggingStudio.exe after packaging,
// so Windows (Task Manager, taskbar, file properties) shows "MyVloggingStudio" instead of "Electron".
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const name = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, name + '.exe');
  const version = (context.packager.appInfo.version || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
  while (version.length < 4) version.push(0);

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // icon: replace every icon group in the file with ours
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map(i => i.data));

  // version info: name shown by Windows
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const langs = vi.getAllLanguagesForStringValues();
  const strings = {
    FileDescription: 'MyVloggingStudio',
    ProductName: 'MyVloggingStudio',
    CompanyName: 'MyVloggingStudio',
    InternalName: 'MyVloggingStudio',
    OriginalFilename: name + '.exe',
    LegalCopyright: '',
    FileVersion: version.join('.'),
    ProductVersion: version.join('.')
  };
  for (const l of (langs.length ? langs : [{ lang: 1033, codepage: 1200 }])) vi.setStringValues(l, strings);
  vi.setFileVersion(...version);
  vi.setProductVersion(...version);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
