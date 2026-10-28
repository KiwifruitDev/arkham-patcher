// Arkham: Revived - PlayStation 3 patcher page controller.
//
// Everything runs in the browser: the official 1.06 PKG is downloaded from
// this site, decrypted in memory, its COALESCED files are patched, and the
// result is either written into a PS3 Backup Utility archive (OFW) or offered
// as a zip of COALESCED files (CFW/HEN).

import { Engine } from './engine.js';
import { buildZip } from './zip.js';
import {
  COALESCED_DIR, EDITION_NAMES, GAME_DIR, REGION_NAMES, REGIONS, regionFor, pkgUrl,
} from './config.js';
import { downloadPkg, extractPkg } from './pkg.js';
import { isCoalescedName, patchCoalescedBlob } from './coalesced.js';
import { buildDirectories, planGamePatch, readBackup, writePatch } from './archive-patch.js';
import {
  TaskProgress, Wizard, detectMobile, downloadBlob, ensureCrossOriginIsolation, formatBytes,
  h, link, supportsFolderPicker, toast,
} from './ui.js';

const COPY_CHUNK = 4 * 1024 * 1024;
const PKG_NAME = 'update.pkg';

const state = {
  mode: null,
  isolated: null,
  mobile: detectMobile(),
  folderPicker: supportsFolderPicker(),
  mobileAcknowledged: false,
  browserAcknowledged: false,
  driveKind: null,
  usbFree: null,
  os: null,
  formatKnown: null,
  rufusUsed: null,
  pmUsed: null,
  linuxProbes: {},
  linuxDistro: null,
  linuxManager: null,
  plugConfirmed: null,
  backup: null,
  backupBusy: false,
  backupError: null,
  regionName: 'US',
  editionName: 'Disc',
  pkgBlob: null,
  pkgEntryKey: null,
  patchFiles: null,
  patchRunning: false,
  patchDone: false,
  patchError: null,
  cancelRequested: false,
  abort: null,
  progress: null,
  result: null,
  staging: null,
  importLine: null,
};

let engine = null;
let wizard = null;
let root = null;

/* ------------------------------------------------------------------ utils */

function basename(path) {
  return String(path).split('/').pop() ?? '';
}

function backupSummary(backup) {
  const sizes = backup.chunkSizes;
  return {
    chunks: sizes.length,
    chunkBytes: sizes.reduce((sum, size) => sum + size, 0),
    files: backup.index.files.length,
    fileBytes: backup.index.files.reduce((sum, file) => sum + file.size, 0),
  };
}

function updateFileCount(titleId) {
  if (!state.backup) return 0;
  return state.backup.index.files.filter(file => file.path.startsWith(`${GAME_DIR(titleId)}/`)).length;
}

function resetPatch() {
  state.pkgBlob = null;
  state.pkgEntryKey = null;
  state.patchFiles = null;
  state.patchDone = false;
  state.patchError = null;
  state.result = null;
}

function isCancelled() {
  return state.cancelRequested;
}

function checkCancel() {
  if (state.cancelRequested) throw new DOMException('Cancelled', 'AbortError');
}

async function getEngine() {
  if (!engine) engine = new Engine();
  await engine.start();
  return engine;
}

/* ------------------------------------------------------------ step: intro */

const firmwareStep = {
  id: 'firmware',
  title: 'Choose your firmware',
  nextLabel: () => null,
  render() {
    const card = (mode, heading, text, tag) => h('button', {
      type: 'button',
      class: `ak-choice${state.mode === mode ? ' ak-choice-selected' : ''}`,
      onclick: () => chooseMode(mode),
    },
      h('span', { class: 'ak-choice-tag' }, tag),
      h('strong', {}, heading),
      h('span', {}, text),
    );

    return h('div', { class: 'ak-page' },
      h('h2', {}, 'What firmware is your PS3 running?'),
      h('p', {}, 'This decides how the patch is installed. You can go back and change it at any time. This tutorial does not cover installing HEN or CFW. If you are unsure, select "OFW (original firmware".'),
      h('div', { class: 'ak-choice-grid' },
        card('cfw', 'CFW or HEN', 'Your PS3 can run homebrew. No backup or restore is needed: you get a zip of patched files for multiMAN (mmCM).', 'Jailbroken'),
        card('ofw', 'OFW (original firmware)', 'Stock firmware with no homebrew. The patch is applied to a Backup Utility backup, then restored on the PS3.', 'Stock'),
      ),
      h('p', { class: 'ak-note' }, 'CFW = custom firmware. HEN = the Homebrew Enabler used with HFW (Hybrid Firmware).'),
    );
  },
};

function chooseMode(mode) {
  if (state.mode === mode) {
    wizard.go(1);
    return;
  }
  state.mode = mode;
  resetPatch();
  wizard.setSteps(buildFlow(), { keep: false });
  wizard.go(1);
}

/* --------------------------------------------------------- OFW drive setup */

const DRIVE_CHOICES = [
  { value: 'usb', tag: 'Recommended', heading: 'USB flash drive', text: 'A normal USB stick plugged straight into the console.' },
  { value: 'sd', tag: 'May not work', heading: 'SD card reader', text: 'An SD card in a USB card reader, or a card slot on the console.' },
  { value: 'sata', tag: 'May not work', heading: 'SATA to USB adapter', text: 'A hard drive or SSD in a SATA-to-USB adapter or enclosure.' },
];

const FREE_SPACE_CHOICES = [
  { value: 'under32', heading: 'Under 32 GB', text: 'Smaller than most PS3 backups.' },
  { value: '32to128', heading: '32 GB to 128 GB' },
  { value: '128to512', heading: '128 GB to 512 GB' },
  { value: '512plus', heading: '512 GB or more' },
  { value: 'unknown', heading: "I don't know", text: 'This page explains how to check.' },
];

const OS_CHOICES = [
  { value: 'windows', heading: 'Windows', text: 'Windows 10 or 11 on a desktop or laptop.' },
  { value: 'macos', heading: 'macOS', text: 'macOS on a MacBook, iMac, Mac mini, Mac Studio, or Mac Pro.' },
  { value: 'linux', heading: 'Linux', text: 'Such as Ubuntu, Debian, Fedora, Arch Linux, etc.' },
];

function strong(text) {
  return h('strong', {}, text);
}

function choiceCard(item) {
  return h('button', {
    type: 'button',
    class: `ak-choice${item.selected ? ' ak-choice-selected' : ''}`,
    onclick: item.onclick,
  },
    item.tag ? h('span', { class: 'ak-choice-tag' }, item.tag) : null,
    h('strong', {}, item.heading),
    item.text ? h('span', {}, item.text) : null,
  );
}

function choiceGrid(items) {
  return h('div', { class: 'ak-choice-grid' }, items.map(choiceCard));
}

function resetFormatFlow() {
  state.rufusUsed = null;
  state.pmUsed = null;
  state.linuxProbes = {};
  state.linuxDistro = null;
  state.linuxManager = null;
  state.plugConfirmed = null;
}

function chooseFrom(currentId, updates, { resetFlow = false } = {}) {
  Object.assign(state, updates);
  if (resetFlow) resetFormatFlow();
  wizard.setSteps(buildFlow());
  const index = wizard.steps.findIndex(step => step.id === currentId);
  wizard.go(index >= 0 ? index + 1 : wizard.index);
}

function formatChecklist() {
  return h('div', { class: 'ak-callout' },
    strong('Before you continue, confirm all four'),
    h('ul', { class: 'ak-list' },
      h('li', {}, 'The drive has a ', strong('single'), ' partition.'),
      h('li', {}, 'That partition is ', strong('FAT32'), ' - not exFAT, not NTFS.'),
      h('li', {}, 'The drive uses the ', strong('MBR'), ' partition table - not GPT.'),
      h('li', {}, 'Anything you wanted to keep from the drive has been copied elsewhere.'),
    ),
  );
}

const ofwDrive = {
  id: 'ofw-drive',
  title: 'Choose a USB drive',
  nextLabel: () => (state.driveKind === 'sd' || state.driveKind === 'sata' ? 'Continue anyway' : null),
  render() {
    const risky = state.driveKind === 'sd' || state.driveKind === 'sata';
    return h('div', { class: 'ak-page' },
      h('h2', {}, '1. Choose a USB drive'),
      h('p', {}, 'The PS3 Backup Utility reads ', strong('FAT32'), ' storage only. A plain USB flash drive is by far the most reliable choice.'),
      choiceGrid(DRIVE_CHOICES.map(item => ({
        selected: state.driveKind === item.value,
        tag: item.tag,
        heading: item.heading,
        text: item.text,
        onclick: () => {
          if (item.value === 'usb') {
            chooseFrom('ofw-drive', { driveKind: item.value });
            return;
          }
          state.driveKind = item.value;
          wizard.refresh();
        },
      }))),
      risky ? h('div', { class: 'ak-status ak-status-error' },
        strong('The PS3 may not accept this device'),
        h('p', {}, state.driveKind === 'sd'
          ? 'SD cards in a USB reader are often not detected by the PS3. Some readers work, many do not, and the PS3 has no list of supported ones.'
          : 'SATA-to-USB adapters are often not detected by the PS3. Some chipsets work, many do not.'),
        h('p', {}, 'You can still try it: if the drive shows up in Backup Utility later in this guide, it works. If it does not, switch to a normal USB flash drive.'),
      ) : null,
      h('div', { class: 'ak-callout' },
        strong('A note on exFAT'),
        h('p', {}, 'Stock firmware does not read exFAT or NTFS drives, and it cannot read a disk that uses the GPT partition table. The drive has to be FAT32 on an MBR disk, which is what the next pages set up.'),
      ),
    );
  },
};

const ofwSize = {
  id: 'ofw-size',
  title: 'Check the drive size',
  nextLabel: () => (state.usbFree ? 'Continue' : null),
  canNext: () => Boolean(state.usbFree),
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '2. Check the drive has enough space'),
      h('p', {}, 'Backup Utility copies everything on the PS3 hard drive, so the USB drive needs ', strong('at least as much free space as the data currently in use on the PS3'), '.'),
      h('div', { class: 'ak-callout' },
        strong('Example'),
        h('p', {}, 'If the PS3 has a 500 GB drive with 300 GB used, the USB drive needs at least 300 GB free. Free space is what matters, not the total size of the drive.'),
      ),
      h('p', { class: 'ak-note' }, 'Leave a few GB extra: the patcher writes the changed data next to the backup before replacing it.'),
      h('p', {}, 'How much free space does the drive have?'),
      choiceGrid(FREE_SPACE_CHOICES.map(item => ({
        selected: state.usbFree === item.value,
        heading: item.heading,
        text: item.text,
        onclick: () => {
          state.usbFree = item.value;
          wizard.refresh();
        },
      }))),
      state.usbFree === 'under32' ? h('div', { class: 'ak-status ak-status-error' },
        strong('That is probably too small'),
        h('p', {}, 'Most PS3 backups are well over 32 GB. Only continue if you know your PS3 has very little data on it - check Settings -> System Settings -> System Information on the console for the used space.'),
        h('p', {}, 'If the PS3 has more data than this, use a bigger drive. The backup cannot be split across several drives.'),
      ) : null,
      state.usbFree === 'unknown' ? h('p', { class: 'ak-note' }, 'Check the free space in your file manager: on Windows, right-click the drive in This PC and open Properties; on macOS, right-click the drive in Finder and choose Get Info; on Linux, open the drive in your file manager or run df -h in a terminal.') : null,
      h('details', { class: 'ak-details' },
        h('summary', {}, 'How do I find out how much data is on my PS3?'),
        h('ol', { class: 'ak-list' },
          h('li', {}, 'On the PS3, open ', strong('Settings'), ' -> ', strong('System Settings'), ' -> ', strong('System Information'), '.'),
          h('li', {}, 'The screen shows the capacity and the free space of the hard drive. Used space is capacity minus free space.'),
        ),
        h('p', { class: 'ak-note' }, 'The backup is slightly larger than the used space, so round up to the next common drive size.'),
      ),
    );
  },
};

const ofwOs = {
  id: 'ofw-os',
  title: 'Choose your computer',
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '3. Which computer are you using?'),
      h('p', {}, 'The next pages show how to format the drive on your computer. The result is always the same: one FAT32 partition on an MBR disk.'),
      choiceGrid(OS_CHOICES.map(item => ({
        selected: state.os === item.value,
        heading: item.heading,
        text: item.text,
        onclick: () => chooseFrom('ofw-os', { os: item.value }, { resetFlow: true }),
      }))),
    );
  },
};

function formatCheckDetails() {
  if (state.os === 'windows') {
    return h('details', { class: 'ak-details' },
      h('summary', {}, 'How do I check the drive on Windows?'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Right-click ', strong('Start'), ' and open ', strong('Disk Management'), '. Find your drive in the list of disks.'),
        h('li', {}, 'Right-click the name of the disk on the left (for example "Disk 1") and choose ', strong('Properties'), ' -> ', strong('Volumes'), '. The ', strong('Partition style'), ' must be ', strong('Master Boot Record'), '.'),
        h('li', {}, 'The drive must show exactly one volume, marked ', strong('FAT32'), '. If it says exFAT, NTFS or RAW, it has to be formatted.'),
        h('li', {}, 'If there are extra volumes, delete them and start again - the PS3 needs a single partition.'),
      ),
    );
  }
  if (state.os === 'macos') {
    return h('details', { class: 'ak-details' },
      h('summary', {}, 'How do I check the drive on macOS?'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Open ', strong('Disk Utility'), ' and choose ', strong('View'), ' -> ', strong('Show All Devices'), '.'),
        h('li', {}, 'Select the drive itself (the top-level entry, not the volume under it), then click ', strong('Info'), '. The ', strong('Partition Map Scheme'), ' must be ', strong('Master Boot Record'), '.'),
        h('li', {}, 'The drive must have exactly one volume, formatted as MS-DOS (FAT). That is macOS\'s name for FAT32.'),
      ),
    );
  }
  return h('details', { class: 'ak-details' },
    h('summary', {}, 'How do I check the drive on Linux?'),
    h('ol', { class: 'ak-list' },
      h('li', {}, 'Open your partition manager (GParted, KDE Partition Manager or Disks).'),
      h('li', {}, 'Select the drive. The partition table type must be ', strong('msdos'), ' (MBR), not gpt.'),
      h('li', {}, 'The drive must have exactly one partition, of type ', strong('fat32'), ' (GParted shows it as W95 FAT32).'),
    ),
    h('p', { class: 'ak-note' }, 'The same information is shown by sudo parted -l in a terminal.'),
  );
}

const ofwFormat = {
  id: 'ofw-format',
  title: "Check the drive's format",
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '4. Is the drive already FAT32 with an MBR partition table?'),
      h('p', {}, 'The PS3 only reads a ', strong('FAT32'), ' partition from a disk that uses the ', strong('MBR'), ' partition table. An exFAT or NTFS drive, or a disk formatted as GPT, will not appear in Backup Utility at all.'),
      choiceGrid([
        {
          selected: state.formatKnown === true,
          tag: 'Skips formatting',
          heading: 'Yes, it is FAT32 and MBR',
          text: 'You already know the drive is set up correctly, so go straight to checking it on the PS3.',
          onclick: () => chooseFrom('ofw-format', { formatKnown: true }, { resetFlow: true }),
        },
        {
          selected: state.formatKnown === false,
          heading: 'No, or not sure',
          text: 'Show the steps to check and format the drive.',
          onclick: () => chooseFrom('ofw-format', { formatKnown: false }, { resetFlow: true }),
        },
      ]),
      formatCheckDetails(),
      h('p', { class: 'ak-note' }, 'If you are not sure, pick "No, or not sure" - the next pages check every requirement and only erase the drive if it needs formatting.'),
    );
  },
};

/* ------------------------------------------------- Windows (Rufus) pages */

const RUFUS_URL = 'https://rufus.ie/en/';

function rufusSteps(verbose) {
  if (verbose) {
    return [
      'Plug the USB drive into the computer. All data on it will be erased, so copy anything you want to keep somewhere else first.',
      'Download the Standard edition of Rufus from rufus.ie and open it. Make sure you select the correct architecture for your system (x64, x86, or ARM64), and do not use the Portable build.',
      'In Rufus, open the Device list and select your USB drive. Check the drive letter and the size, because the drive you pick is the drive that gets erased.',
      'Set Boot selection to Non bootable.',
      'Set Partition scheme to MBR. The PS3 cannot read GPT disks.',
      'Set File system to Large FAT32. Plain FAT32 stops at 32 GB, which is why Windows itself cannot format a bigger drive as FAT32; Large FAT32 formats the whole drive.',
      'Click START, accept the warning that everything on the drive will be destroyed, and wait for "READY" to appear.',
    ];
  }
  return [
    'Plug the USB drive into the computer. Everything on it will be erased.',
    'Download the Standard edition of Rufus from rufus.ie (not the Portable build) and open it.',
    'Select your USB drive under Device.',
    'Set Boot selection to Non bootable.',
    'Make sure Partition scheme says MBR and File system says Large FAT32.',
    'Click START and confirm that everything on the drive can be erased.',
  ];
}

function rufusScreenshot() {
  const image = h('img', {
    class: 'ak-shot',
    src: '/img/arkhamrevived/rufus.png',
    alt: 'Rufus with the USB drive selected, Boot selection set to Non bootable, Partition scheme set to MBR and File system set to Large FAT32',
    loading: 'lazy',
  });
  return h('div', {},
    h('a', { class: 'ak-shot-link', href: '/img/arkhamrevived/rufus.png', target: '_blank', rel: 'noreferrer' }, image),
    h('p', { class: 'ak-note' }, 'Rufus with the correct settings: Non bootable, MBR and Large FAT32. Click the image to open it full size.'),
  );
}

const ofwWindowsKnow = {
  id: 'ofw-windows-know',
  title: 'Rufus experience',
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Format the drive with Rufus'),
      h('p', {}, 'Windows can only create FAT32 partitions up to 32 GB in Disk Management, so a larger drive needs Rufus. Rufus can format the whole drive as FAT32 with an MBR partition table in one go.'),
      h('p', {}, 'Have you used Rufus to format a drive as FAT32 with the MBR partition scheme before?'),
      choiceGrid([
        {
          selected: state.rufusUsed === true,
          heading: 'Yes, I have used Rufus before',
          text: 'Show the short version of the steps.',
          onclick: () => chooseFrom('ofw-windows-know', { rufusUsed: true }),
        },
        {
          selected: state.rufusUsed === false,
          heading: 'No, or I want the full walkthrough',
          text: 'Explain every setting in Rufus.',
          onclick: () => chooseFrom('ofw-windows-know', { rufusUsed: false }),
        },
      ]),
    );
  },
};

const ofwWindowsGuide = {
  id: 'ofw-windows-guide',
  title: 'Format with Rufus',
  nextLabel: () => 'Continue',
  render() {
    const verbose = state.rufusUsed === false;
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Format the drive with Rufus'),
      h('p', {}, 'Download Rufus from ', link(RUFUS_URL, 'rufus.ie'), ': pick the ', strong('Standard'), ' build for your PC. Do not download the Portable build, and make sure you select the correct architecture for your system (x64, x86, or ARM64).'),
      h('ol', { class: 'ak-list' }, rufusSteps(verbose).map(step => h('li', {}, step))),
      rufusScreenshot(),
      verbose ? h('div', { class: 'ak-status ak-status-error' },
        strong('Everything on the drive is deleted'),
        h('p', {}, 'Rufus erases the whole drive when you click START. Copy any files you want to keep to another drive first.'),
      ) : null,
      h('p', { class: 'ak-note' }, 'If File system does not offer Large FAT32, Rufus did not detect the drive as removable - check the Device selection again.'),
      formatChecklist(),
    );
  },
};

/* ---------------------------------------------------------- Linux pages */

const LINUX_DISTROS = [
  { value: 'ubuntu', heading: 'Ubuntu', command: 'sudo apt install gparted' },
  { value: 'debian', heading: 'Debian', command: 'sudo apt install gparted' },
  { value: 'fedora', heading: 'Fedora', command: 'sudo dnf install gparted' },
  { value: 'arch', heading: 'Arch Linux', command: 'sudo pacman -S gparted' },
  { value: 'unknown', heading: "I don't know", command: null },
];

const LINUX_GUIDES = {
  gparted: {
    heading: 'GParted',
    steps: verbose => verbose ? [
      'Open GParted. If it asks for a password, enter your own - it needs root privileges to write to the drive.',
      'Pick your USB drive in the drop-down list at the top right. Check the size and model so you do not pick your system disk.',
      'Choose Device -> Create Partition Table, select msdos and click Apply. This replaces the partition table with MBR and erases the whole drive.',
      'Right-click the unallocated space and choose New. Set New size to the whole space and File system to fat32, then click Add.',
      'Click the green tick (Apply All Operations) and confirm.',
    ] : [
      'Open GParted and pick your USB drive in the list at the top right.',
      'Device -> Create Partition Table -> msdos.',
      'Right-click the unallocated space -> New -> File system: fat32 -> Add.',
      'Click Apply All Operations.',
    ],
  },
  kde: {
    heading: 'KDE Partition Manager',
    steps: verbose => verbose ? [
      'Open KDE Partition Manager. It asks for your password because it needs root privileges.',
      'Select your USB drive under Devices on the left. Check the size and model so you do not pick your system disk.',
      'Choose Device -> Create New Partition Table, select msdos (MBR) and click OK. This erases the whole drive.',
      'Right-click the unallocated space and choose New. Pick FAT32 as the file system and use the whole size, then click OK.',
      'Click Apply (or Save Operations) and confirm.',
    ] : [
      'Open KDE Partition Manager and select your USB drive.',
      'Device -> Create New Partition Table -> msdos (MBR).',
      'Right-click the unallocated space -> New -> FAT32 -> OK.',
      'Click Apply.',
    ],
  },
  disks: {
    heading: 'Disks (GNOME)',
    steps: verbose => verbose ? [
      'Open Disks (it may be called "Disks" or "GNOME Disks" in your applications menu).',
      'Select your USB drive in the list on the left. Check the size and model so you do not pick your system disk.',
      'Open the menu at the top right (three dots) and choose Format Disk. Set Partitioning to "Compatible with all systems (MBR)" and click Format. This erases the whole drive.',
      'Select the free space that appears under the drive, click the + button, set Type to FAT and use the whole size, then click Create.',
    ] : [
      'Open Disks and select your USB drive.',
      'Menu -> Format Disk -> "Compatible with all systems (MBR)" -> Format.',
      'Select the free space -> + -> Type: FAT, whole size -> Create.',
    ],
  },
};

const ofwLinuxKnow = {
  id: 'ofw-linux-know',
  title: 'Format the drive',
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Format the drive as FAT32'),
      h('p', {}, 'Linux distributions ship with different tools for this, so the guide depends on what you have. Anything that can write an MBR table and a FAT32 partition will do.'),
      h('p', {}, 'Have you used a partition manager (GParted, KDE Partition Manager, Disks) before?'),
      choiceGrid([
        {
          selected: state.pmUsed === true,
          heading: 'Yes, I have',
          text: 'Pick the tool you want to use and see short instructions.',
          onclick: () => chooseFrom('ofw-linux-know', { pmUsed: true }),
        },
        {
          selected: state.pmUsed === false,
          heading: 'No, help me find one',
          text: 'Check which partition manager is installed and get a step-by-step walkthrough.',
          onclick: () => chooseFrom('ofw-linux-know', { pmUsed: false }),
        },
      ]),
    );
  },
};

const ofwLinuxManager = {
  id: 'ofw-linux-manager',
  title: 'Pick a partition manager',
  nextLabel: () => null,
  render() {
    const verbose = state.pmUsed === false;
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Select which partition manager you would like to use'),
      h('p', {}, verbose
        ? 'Pick the tool you just installed (or found in your applications menu). Short instructions follow either way.'
        : 'Pick the tool you would like to use and the steps for it are shown next.'),
      choiceGrid([
        {
          selected: state.linuxManager === 'gparted',
          tag: 'Recommended',
          heading: 'GParted',
          text: 'The most common tool for this, and the easiest to follow.',
          onclick: () => chooseFrom('ofw-linux-manager', { linuxManager: 'gparted' }),
        },
        {
          selected: state.linuxManager === 'kde',
          heading: 'KDE Partition Manager',
          text: 'Usually included with KDE Plasma.',
          onclick: () => chooseFrom('ofw-linux-manager', { linuxManager: 'kde' }),
        },
        {
          selected: state.linuxManager === 'disks',
          heading: 'Disks (GNOME)',
          text: 'Usually included with GNOME, simple but less detailed.',
          onclick: () => chooseFrom('ofw-linux-manager', { linuxManager: 'disks' }),
        },
        {
          tag: 'Advanced',
          heading: 'Skip, I know what I am doing',
          text: 'Format the drive yourself: one FAT32 partition on an MBR disk, then continue.',
          onclick: () => wizard.goToId('ofw-plug-check'),
        },
      ]),
    );
  },
};

function linuxProbeStep({ id, title, question, search, manager }) {
  return {
    id: `ofw-linux-${id}`,
    title,
    nextLabel: () => null,
    render() {
      const answer = state.linuxProbes[id];
      return h('div', { class: 'ak-page' },
        h('h2', {}, '5. Find a partition manager'),
        h('p', {}, 'Open your applications menu (or the Activities overview) and search for ', strong(search), '.'),
        h('p', {}, question),
        choiceGrid([
          {
            selected: answer === true,
            heading: 'Yes, it is there',
            text: 'Show the steps for it.',
            onclick: () => chooseFrom(`ofw-linux-${id}`, {
              linuxManager: manager,
              linuxProbes: { ...state.linuxProbes, [id]: true },
            }),
          },
          {
            selected: answer === false,
            heading: 'No, it is not installed',
            text: 'Check for another tool.',
            onclick: () => chooseFrom(`ofw-linux-${id}`, {
              linuxProbes: { ...state.linuxProbes, [id]: false },
            }),
          },
        ]),
      );
    },
  };
}

const ofwLinuxDisks = linuxProbeStep({
  id: 'disks',
  title: 'Look for Disks',
  search: 'Disks',
  question: 'Does an application named "Disks" show up?',
  manager: 'disks',
});

const ofwLinuxPartition = linuxProbeStep({
  id: 'partition',
  title: 'Look for KDE Partition Manager',
  search: 'Partition',
  question: 'Does an application named "KDE Partition Manager" show up?',
  manager: 'kde',
});

const ofwLinuxGparted = linuxProbeStep({
  id: 'gparted',
  title: 'Look for GParted',
  search: 'GParted',
  question: 'Does an application named "GParted" show up?',
  manager: 'gparted',
});

const ofwLinuxDistro = {
  id: 'ofw-linux-distro',
  title: 'Choose your distribution',
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. No partition manager found'),
      h('p', {}, 'None of the usual partition managers are installed. One quick install fixes that. Which distribution are you using?'),
      choiceGrid(LINUX_DISTROS.map(item => ({
        selected: state.linuxDistro === item.value,
        heading: item.heading,
        onclick: () => chooseFrom('ofw-linux-distro', { linuxDistro: item.value }),
      }))),
    );
  },
};

const ofwLinuxInstall = {
  id: 'ofw-linux-install',
  title: 'Install a partition manager',
  nextLabel: () => 'Continue',
  render() {
    const distro = LINUX_DISTROS.find(item => item.value === state.linuxDistro);
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Install GParted'),
      distro?.command
        ? h('div', {},
          h('p', {}, `Open a terminal and run this on ${distro.heading}:`),
          h('pre', { class: 'ak-command' }, distro.command),
          h('p', { class: 'ak-note' }, 'It asks for your password and downloads a few MB.'),
        )
        : h('div', {},
          h('p', {}, 'Open your distribution\'s software centre and search for ', strong('GParted'), ' (or ', strong('Disks'), ' / ', strong('GNOME Disks'), '). If you prefer a terminal, install the gparted package with your normal package manager.'),
        ),
      h('p', {}, 'Once it is installed, open it from your applications menu and continue.'),
    );
  },
};

const ofwLinuxGuide = {
  id: 'ofw-linux-guide',
  title: 'Format on Linux',
  nextLabel: () => 'Continue',
  render() {
    const guide = LINUX_GUIDES[state.linuxManager];
    const verbose = state.pmUsed === false;
    if (!guide) {
      return h('div', { class: 'ak-page' },
        h('h2', {}, '5. Format the drive as FAT32'),
        h('p', {}, 'Format the drive yourself: one FAT32 partition on an MBR disk.'),
        formatChecklist(),
      );
    }
    return h('div', { class: 'ak-page' },
      h('h2', {}, `5. Format the drive with ${guide.heading}`),
      h('ol', { class: 'ak-list' }, guide.steps(verbose).map(step => h('li', {}, step))),
      verbose ? h('div', { class: 'ak-status ak-status-error' },
        strong('This erases the whole drive'),
        h('p', {}, 'Creating the partition table wipes every file on the drive. Copy anything you want to keep somewhere else first.'),
      ) : null,
      formatChecklist(),
    );
  },
};

/* ----------------------------------------------------------- macOS pages */

const ofwMacKnow = {
  id: 'ofw-macos-know',
  title: 'Format the drive',
  nextLabel: () => null,
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Format the drive with Disk Utility'),
      h('p', {}, 'Disk Utility can erase the drive and set it up as FAT32 with an MBR partition table. No extra software is needed.'),
      h('p', {}, 'Have you used Disk Utility (or a partition manager) to erase and partition a drive before?'),
      choiceGrid([
        {
          selected: state.pmUsed === true,
          heading: 'Yes, I have',
          text: 'Show the short version of the steps.',
          onclick: () => chooseFrom('ofw-macos-know', { pmUsed: true }),
        },
        {
          selected: state.pmUsed === false,
          heading: 'No, walk me through it',
          text: 'Explain each step in Disk Utility.',
          onclick: () => chooseFrom('ofw-macos-know', { pmUsed: false }),
        },
      ]),
    );
  },
};

const ofwMacGuide = {
  id: 'ofw-macos-guide',
  title: 'Disk Utility',
  nextLabel: () => 'Continue',
  render() {
    const verbose = state.pmUsed === false;
    const steps = verbose ? [
      'Open Disk Utility: press Command and Space, type Disk Utility, then press Return. It is also in Applications -> Utilities.',
      'Choose View -> Show All Devices. Without this, Disk Utility only lists the volumes on each drive and you cannot set the partition scheme.',
      'Select the drive itself in the sidebar - the top-level entry, not the volume below it. Check the size and name so you do not pick your startup disk.',
      'Click Erase at the top of the window.',
      'Set Name to something like PS3, Format to MS-DOS (FAT) and Scheme to Master Boot Record. MS-DOS (FAT) is macOS\'s name for FAT32.',
      'Click Erase and confirm. Everything on the drive is deleted, and you get a single FAT32 partition on an MBR disk.',
    ] : [
      'Open Disk Utility and choose View -> Show All Devices.',
      'Select the drive (not the volume below it) and click Erase.',
      'Set Format to MS-DOS (FAT) and Scheme to Master Boot Record.',
      'Click Erase and confirm.',
    ];
    return h('div', { class: 'ak-page' },
      h('h2', {}, '5. Format the drive with Disk Utility'),
      h('ol', { class: 'ak-list' }, steps.map(step => h('li', {}, step))),
      verbose ? h('div', { class: 'ak-status' },
        strong('If Scheme is not shown'),
        h('p', {}, 'You selected a volume instead of the drive. Go back one level in the sidebar and select the drive itself (the entry with the size and connection type under it).'),
      ) : null,
      h('p', { class: 'ak-note' }, 'Formatting erases the whole drive. Copy anything you want to keep somewhere else first.'),
      formatChecklist(),
    );
  },
};

/* ------------------------------------------------------------ plug in page */

const ofwPlugCheck = {
  id: 'ofw-plug-check',
  title: 'Confirm the PS3 sees the drive',
  nextLabel: () => (state.plugConfirmed === null ? null : 'Continue'),
  render() {
    const failed = state.plugConfirmed === false;
    return h('div', { class: 'ak-page' },
      h('h2', {}, '6. Check the PS3 can see the drive'),
      h('p', {}, 'Plug the drive into the PS3 and open ', strong('Settings'), ' -> ', strong('System Settings'), ' -> ', strong('Backup Utility'), '. If the PS3 can read it, the drive is listed there as a USB device.'),
      h('p', { class: 'ak-note' }, 'Nothing is written to the drive yet, so you can unplug it again straight away. This step only proves the PS3 accepts it before you spend time on the backup.'),
      state.plugConfirmed === true ? h('p', { class: 'ak-note' }, 'The PS3 accepted the drive. Continue to delete the old game data on the console.') : null,
      choiceGrid([
        {
          selected: state.plugConfirmed === true,
          heading: 'Yes, Backup Utility lists the drive',
          text: 'Continue to the game data and backup steps.',
          onclick: () => chooseFrom('ofw-plug-check', { plugConfirmed: true }),
        },
        {
          selected: failed,
          heading: 'No, nothing shows up',
          text: 'Show what to check.',
          onclick: () => {
            state.plugConfirmed = false;
            wizard.refresh();
          },
        },
      ]),
      failed ? h('div', { class: 'ak-status ak-status-error' },
        strong('The PS3 cannot read the drive yet'),
        h('ul', { class: 'ak-list' },
          h('li', {}, 'The drive must be one FAT32 partition on an MBR disk. exFAT and NTFS volumes are ignored, and so is a GPT disk.'),
          h('li', {}, 'More than one partition can confuse Backup Utility. Format it again so it has a single FAT32 partition.'),
          h('li', {}, state.driveKind === 'sd' || state.driveKind === 'sata'
            ? 'Card readers and SATA-to-USB adapters are frequently not detected by the PS3. This is the most likely cause here - try a plain USB flash drive.'
            : 'Try the other USB port on the front of the PS3 and check the drive is fully inserted.'),
          h('li', {}, 'Give the Backup Utility screen a few seconds, or leave and reopen it, so it can rescan the ports.'),
        ),
        h('p', {}, 'You can continue anyway - the patcher writes the backup archive regardless. The PS3 just will not be able to restore it until it can read the drive, so fixing this now saves time later.'),
      ) : null,
    );
  },
};

/* ------------------------------------------------------------- OFW pages */

const ofwDelete = {
  id: 'ofw-delete',
  title: 'Delete the old game data',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '7. Delete the old game data'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'On the PS3 XMB, go to ', h('strong', {}, 'Game'), ' -> ', h('strong', {}, 'Game Data Utility'), '.'),
        h('li', {}, 'Highlight the item labeled ', h('strong', {}, '"Batman: Arkham Origins"'), ' (about 70 MB).'),
        h('li', {}, 'Press ', h('strong', {}, 'Triangle'), ' -> ', h('strong', {}, 'Delete'), ', then confirm.'),
      ),
      h('p', {}, 'This removes the old title update so the patched one can be restored cleanly. Save files and the installed game are not affected.'),
      h('p', { class: 'ak-note' }, 'If there are several Arkham Origins entries, make sure to only delete the one that is about 70 MB in size.'),
    );
  },
};

const ofwBackup = {
  id: 'ofw-backup',
  title: 'Back up the PS3',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '8. Back up your PS3'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Go to ', h('strong', {}, 'Settings'), ' -> ', h('strong', {}, 'System Settings'), ' -> ', h('strong', {}, 'Backup Utility'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Back Up"'), ' -> ', h('strong', {}, '"USB Device"'), '.'),
        h('li', {}, 'Choose the USB drive and wait for the backup to finish. Do not turn the console off while it runs.'),
      ),
      h('p', {}, 'When the PS3 is done, unplug the USB drive and connect it to this computer.'),
    );
  },
};

const selectStep = {
  id: 'ofw-select',
  title: 'Select the backup',
  nextLabel: () => 'Continue',
  canNext: () => Boolean(state.backup),
  render() {
    const controls = [];
    const error = state.backupError ? h('p', { class: 'ak-error-text' }, state.backupError) : null;

    if (!state.isolated) {
      return h('div', { class: 'ak-page' },
        h('h2', {}, '9. Select your backup on this computer'),
        h('div', { class: 'ak-status ak-status-error' },
          h('strong', {}, 'This browser cannot run the backup editor'),
          h('p', {}, 'The WebAssembly backup writer needs SharedArrayBuffer, which this browser does not expose here. Use Chrome, Edge, Firefox or Safari on a desktop, or use the CFW/HEN flow, which does not touch the backup.'),
          h('button', {
            type: 'button',
            class: 'ak-button',
            onclick: () => {
              state.mode = 'cfw';
              wizard.setSteps(buildFlow(), { keep: false });
              wizard.goToId('cfw-intro');
            },
          }, 'Use the CFW/HEN flow instead'),
        ),
      );
    }

    if (state.folderPicker) {
      controls.push(h('button', {
        type: 'button',
        class: 'ak-button',
        disabled: state.backupBusy,
        onclick: chooseFolder,
      }, 'Select backup folder'));
      controls.push(h('p', { class: 'ak-note' }, 'Recommended on Chrome/Edge: the patched files are written straight to the USB drive.'));
    } else if (!state.mobile) {
      controls.push(h('label', { class: 'ak-button ak-button-file' },
        state.backupBusy ? 'Reading the backup...' : 'Select backup folder',
        h('input', {
          type: 'file', multiple: true, webkitdirectory: '', directory: '',
          disabled: state.backupBusy,
          onchange: event => importFileSelection(event.target.files),
        }),
      ));
      controls.push(h('p', { class: 'ak-note' }, 'This browser cannot write to the USB drive, so the patched files will be downloaded for you to copy across.'));
    } else {
      controls.push(h('label', { class: 'ak-button ak-button-file' },
        state.backupBusy ? 'Reading the backup...' : 'Select backup files',
        h('input', {
          type: 'file', multiple: true, accept: '.dat,application/octet-stream',
          disabled: state.backupBusy,
          onchange: event => importFileSelection(event.target.files),
        }),
      ));
      controls.push(h('p', { class: 'ak-note' }, 'Select archive.dat and every archive_*.dat from the backup folder. Folder selection is not available on this device.'));
    }

    state.importLine = h('p', { class: 'ak-busy' }, '');
    const summary = state.backup ? backupSummary(state.backup) : null;
    const status = summary
      ? h('div', { class: 'ak-status ak-status-ok' },
        h('strong', {}, 'Backup loaded'),
        h('p', {}, `${state.backup.name} · archive.dat + ${summary.chunks} data chunk${summary.chunks === 1 ? '' : 's'} (${formatBytes(summary.chunkBytes)})`),
        h('p', {}, `${summary.files.toLocaleString()} files (${formatBytes(summary.fileBytes)}) · archive id ${state.backup.index.id}`),
        h('p', { class: 'ak-note' }, state.backup.kind === 'folder'
          ? 'The backup can be written to directly.'
          : 'The patched files will be downloaded as a zip.'),
      )
      : null;

    return h('div', { class: 'ak-page' },
      h('h2', {}, '9. Select your backup on this computer'),
      h('p', {}, 'Open the USB drive in your file manager. The backup is the folder that contains ', h('code', {}, 'archive.dat'), ' - usually ', h('code', {}, 'PS3/EXPORT/<timestamp>'), '.'),
      h('div', { class: 'ak-controls' }, controls),
      error,
      state.backupBusy ? state.importLine : null,
      status,
    );
  },
};

async function chooseFolder() {
  state.backupError = null;
  try {
    const picked = await window.showDirectoryPicker({ id: 'arkham-ps3-backup', mode: 'readwrite' });
    const dirHandle = await findBackupDirectory(picked);
    await loadDirectoryBackup(dirHandle);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.backupError = error?.message ?? String(error);
    wizard.refresh();
  }
}

async function findBackupDirectory(dir) {
  try {
    await dir.getFileHandle('archive.dat');
    return dir;
  } catch {
    // The user may have picked PS3/EXPORT; look for a single timestamp folder.
  }
  const candidates = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'directory' || name.startsWith('.')) continue;
    try {
      await handle.getFileHandle('archive.dat');
      candidates.push(handle);
    } catch {
      // not a backup
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('That folder contains several backups. Select the timestamp folder you want.');
  throw new Error('No archive.dat was found in the selected folder.');
}

async function loadDirectoryBackup(dirHandle, { kind = 'folder' } = {}) {
  state.backupBusy = true;
  state.backupError = null;
  state.backup = null;
  wizard.refresh();
  if (state.importLine) state.importLine.textContent = 'Reading the backup index...';
  try {
    const instance = await getEngine();
    const backup = await readBackup({
      engine: instance,
      dirHandle,
      onProgress: text => {
        if (state.importLine) state.importLine.textContent = `${text}...`;
      },
    });
    state.backup = { ...backup, dirHandle, name: dirHandle.name, kind };
    resetPatch();
  } catch (error) {
    state.backupError = error?.message ?? String(error);
    state.backup = null;
  } finally {
    state.backupBusy = false;
    wizard.refresh();
  }
}

async function importFileSelection(fileList) {
  state.backupError = null;
  const files = [...(fileList ?? [])];
  const wanted = files.filter(file => {
    const name = basename(file.webkitRelativePath || file.name);
    return name === 'archive.dat' || /^archive_\d+\.dat$/i.test(name);
  });
  const archives = wanted.filter(file => basename(file.webkitRelativePath || file.name) === 'archive.dat');
  if (!archives.length) {
    state.backupError = 'archive.dat was not in that selection. Select the whole backup folder (or archive.dat plus every archive_*.dat).';
    wizard.refresh();
    return;
  }
  if (archives.length > 1) {
    state.backupError = 'That selection contains more than one backup. Select the timestamp folder you want (the one containing the archive.dat you need).';
    wizard.refresh();
    return;
  }
  state.backupBusy = true;
  state.importLine = h('p', { class: 'ak-busy' }, 'Checking browser storage...');
  wizard.refresh();
  try {
    if (!navigator.storage?.getDirectory) {
      throw new Error('This browser cannot stage the backup files. Use Chrome, Edge, Firefox or Safari on a computer.');
    }
    const total = wanted.reduce((sum, file) => sum + file.size, 0);
    const estimate = await navigator.storage.estimate().catch(() => null);
    if (estimate?.quota && estimate.quota - estimate.usage < total * 2.1) {
      throw new Error(`Not enough browser storage for this backup. About ${formatBytes(total * 2)} is needed; this browser allows ${formatBytes(Math.max(0, estimate.quota - estimate.usage))}. Use the Chromium folder option on a computer, or free up space.`);
    }
    const opfsRoot = await navigator.storage.getDirectory();
    const dirHandle = await opfsRoot.getDirectoryHandle(`arkham-ps3-${Date.now()}`, { create: true });
    let done = 0;
    const line = state.importLine ?? h('p');
    state.importLine = line;
    for (const file of wanted) {
      const name = basename(file.webkitRelativePath || file.name);
      line.textContent = `Copying ${name} into browser storage...`;
      const handle = await dirHandle.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      try {
        for (let offset = 0; offset < file.size; offset += COPY_CHUNK) {
          const end = Math.min(offset + COPY_CHUNK, file.size);
          const buffer = await file.slice(offset, end).arrayBuffer();
          await writable.write(buffer);
          done += buffer.byteLength;
          line.textContent = `Copying ${name} into browser storage... ${formatBytes(done)} of ${formatBytes(total)}`;
        }
      } finally {
        await writable.close();
      }
    }
    await loadDirectoryBackup(dirHandle, { kind: 'files' });
  } catch (error) {
    state.backupError = error?.message ?? String(error);
    state.backup = null;
  } finally {
    state.backupBusy = false;
    wizard.refresh();
  }
}

/* ------------------------------------------------------------- region page */

const regionStep = {
  id: 'region',
  title: 'Choose the game version',
  nextLabel: () => 'Continue',
  canNext: () => Boolean(regionFor(state.regionName, state.editionName)),
  render() {
    const regionSelect = h('select', {
      class: 'ak-select',
      onchange: event => {
        state.regionName = event.target.value;
        resetPatch();
        wizard.refresh();
      },
    }, REGION_NAMES.map(name => h('option', { value: name, selected: name === state.regionName }, name)));

    const editionSelect = h('select', {
      class: 'ak-select',
      onchange: event => {
        state.editionName = event.target.value;
        resetPatch();
        wizard.refresh();
      },
    }, EDITION_NAMES.map(name => h('option', { value: name, selected: name === state.editionName }, name)));

    const entry = regionFor(state.regionName, state.editionName);
    const existing = entry ? updateFileCount(entry.titleId) : 0;

    return h('div', { class: 'ak-page' },
      h('h2', {}, 'Choose your game version'),
      h('p', {}, 'Pick the region and edition you own. This must match the disc or the PlayStation Store copy, because each version installs into a different folder.'),
      h('div', { class: 'ak-form' },
        h('label', {}, h('span', {}, 'Region'), regionSelect),
        h('label', {}, h('span', {}, 'Edition'), editionSelect),
      ),
      entry ? h('div', { class: 'ak-status' },
        h('strong', {}, `${entry.region} · ${entry.edition} · ${entry.titleId}`),
        h('p', {}, `Update file: ${entry.file} (${formatBytes(entry.size)})`),
        state.backup ? h('p', { class: 'ak-note' }, existing
          ? `This backup already has ${existing.toLocaleString()} file${existing === 1 ? '' : 's'} in /dev_hdd0/game/${entry.titleId}; they will be replaced or kept as appropriate.`
          : `/dev_hdd0/game/${entry.titleId} is not in this backup yet and will be created.`) : null,
      ) : null,
      h('details', { class: 'ak-details' },
        h('summary', {}, 'Which title ID do I have?'),
        h('table', { class: 'ak-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Region'), h('th', {}, 'Disc'), h('th', {}, 'Digital'))),
          h('tbody', {},
            ...REGIONS.reduce((rows, item) => {
              if (item.edition !== 'Disc') return rows;
              const digital = REGIONS.find(other => other.region === item.region && other.edition === 'Digital');
              rows.push(h('tr', {},
                h('td', {}, item.region),
                h('td', {}, item.titleId),
                h('td', {}, digital?.titleId ?? '-'),
              ));
              return rows;
            }, []),
          ),
        ),
        h('p', { class: 'ak-note' }, 'On a PS3, the title ID is shown in the game data folder name under Game Data Utility, or on the disc spine/label.'),
      ),
    );
  },
};

/* -------------------------------------------------------------- patch page */

const patchStep = {
  id: 'patch',
  title: 'Patch',
  nextLabel: () => (state.patchDone ? 'Continue' : null),
  canNext: () => state.patchDone && !state.patchRunning,
  render() {
    const entry = regionFor(state.regionName, state.editionName);
    const page = h('div', { class: 'ak-page' },
      h('h2', {}, state.mode === 'cfw' ? 'Patch the COALESCED files' : 'Patch the backup'),
      h('p', {}, state.mode === 'cfw'
        ? `The official ${entry?.titleId ?? ''} 1.06 update is downloaded from this page, decrypted locally, and every COALESCED file it contains gets the Arkham: Revived redirect and has its startup movie disabled. Nothing is uploaded.`
        : `The official ${entry?.titleId ?? ''} 1.06 update is downloaded from this page and merged into your backup. Only the end of the archive is rewritten. Nothing is uploaded.`),
    );

    if (state.patchRunning && state.progress) {
      page.append(state.progress.node);
    } else if (state.patchError) {
      page.append(h('div', { class: 'ak-status ak-status-error' },
        h('strong', {}, 'The patch did not finish'),
        h('p', {}, state.patchError),
      ));
      page.append(h('button', { type: 'button', class: 'ak-button', onclick: startPatch }, 'Try again'));
    } else if (!state.patchDone) {
      page.append(h('button', {
        type: 'button',
        class: 'ak-button ak-button-primary',
        disabled: !entry || (state.mode === 'ofw' && !state.backup),
        onclick: startPatch,
      }, state.mode === 'cfw' ? 'Download and patch' : 'Patch my backup'));
      if (state.mode === 'ofw' && !state.backup) {
        page.append(h('p', { class: 'ak-error-text' }, 'Select your backup folder first (go back).'));
      }
    } else {
      page.append(h('div', { class: 'ak-status ak-status-ok' }, h('strong', {}, 'Patch complete')));
    }
    return page;
  },
};

async function startPatch() {
  const entry = regionFor(state.regionName, state.editionName);
  if (!entry) return;
  if (state.mode === 'ofw' && !state.backup) {
    toast('Select your PS3 backup first.', { kind: 'error' });
    return;
  }

  resetPatch();
  state.patchRunning = true;
  state.cancelRequested = false;
  state.abort = new AbortController();

  const progress = new TaskProgress();
  state.progress = progress;
  const phases = state.mode === 'cfw'
    ? [
      { id: 'download', label: 'Downloading', weight: 35 },
      { id: 'extract', label: 'Decrypting', weight: 35 },
      { id: 'coalesced', label: 'Patching config', weight: 10 },
      { id: 'zip', label: 'Building zip', weight: 20 },
    ]
    : [
      { id: 'download', label: 'Downloading', weight: 22 },
      { id: 'extract', label: 'Decrypting', weight: 20 },
      { id: 'coalesced', label: 'Patching config', weight: 4 },
      { id: 'read', label: 'Reading backup', weight: 4 },
      { id: 'write', label: 'Writing archive', weight: 32 },
      { id: 'install', label: 'Installing', weight: 18 },
    ];
  progress.begin(phases, {
    cancellable: true,
    onCancel: () => {
      state.cancelRequested = true;
      state.abort?.abort();
    },
  });
  wizard.refresh();

  try {
    // 1. Download
    progress.setPhase('download', `Downloading the official 1.06 update (${formatBytes(entry.size)})`);
    if (!state.pkgBlob || state.pkgEntryKey !== entry.key) {
      state.pkgBlob = await downloadPkg(pkgUrl(entry), {
        expectedSize: entry.size,
        signal: state.abort.signal,
        shouldCancel: isCancelled,
        onProgress: (done, total) => progress.setProgress(done, total, `${formatBytes(done)} of ${formatBytes(total)}`),
      });
      state.pkgEntryKey = entry.key;
      state.patchFiles = null;
    }
    checkCancel();
    progress.setFraction(1);

    // 2. Extract
    progress.setPhase('extract', 'Decrypting the title update in memory');
    if (!state.patchFiles) {
      const pkg = await extractPkg(state.pkgBlob, {
        shouldCancel: isCancelled,
        onProgress: info => {
          if (info.phase === 'names') {
            progress.setFraction(0.1 * (info.done / Math.max(1, info.total)));
            progress.setDetail(`${info.done.toLocaleString()} files`);
          } else {
            progress.setFraction(0.1 + 0.9 * (info.done / Math.max(1, info.total)));
            progress.setDetail(`${formatBytes(info.done)} of ${formatBytes(info.total)}`);
          }
        },
      });
      if (pkg.titleId !== entry.titleId) {
        throw new Error(`This update is for ${pkg.titleId}, but ${entry.titleId} was selected. Choose the correct region/edition.`);
      }
      state.patchFiles = pkg.files;
      state.pkgInfo = { titleId: pkg.titleId, appVer: pkg.appVer, title: pkg.title };
    }
    checkCancel();
    progress.setFraction(1);

    // 3. Patch COALESCED files
    progress.setPhase('coalesced', 'Patching PS3-BmNetVars.ini and PS3-BmEngine.ini');
    const updated = [];
    const inCookedDir = path => isCoalescedName(path) && path.toUpperCase().includes('/COOKEDPS3/');
    const coalesced = state.patchFiles.filter(file => inCookedDir(file.path));
    if (!coalesced.length) throw new Error('The update does not contain any COALESCED files.');
    for (let index = 0; index < state.patchFiles.length; index++) {
      const file = state.patchFiles[index];
      if (!inCookedDir(file.path)) {
        updated.push(file);
        continue;
      }
      const patched = await patchCoalescedBlob(file.blob);
      if (!patched.redirect) throw new Error(`${basename(file.path)} does not contain BmGame/Config/PS3-BmNetVars.ini.`);
      updated.push({ ...file, blob: patched.blob, size: patched.blob.size });
      progress.setFraction((coalesced.findIndex(item => item.path === file.path) + 1) / coalesced.length);
      progress.setDetail(basename(file.path));
      checkCancel();
    }
    progress.setFraction(1);

    if (state.mode === 'cfw') {
      progress.setPhase('zip', 'Building the COALESCED zip');
      const archive = await buildCoalescedZip(updated, entry, bytes => {
        progress.setFraction(bytes.total ? bytes.done / bytes.total : 0);
        progress.setDetail(`${formatBytes(bytes.done)} of ${formatBytes(bytes.total)}`);
      });
      state.result = { kind: 'cfw-zip', ...archive };
      progress.finish();
      state.patchDone = true;
      state.patchRunning = false;
      wizard.refresh();
      return;
    }

    // 4. Read the backup (already loaded, but re-check the layout)
    progress.setPhase('read', 'Reading the backup index');
    const backup = state.backup;
    progress.setFraction(0.5);
    checkCancel();
    const gameRoot = GAME_DIR(entry.titleId);
    const plan = planGamePatch({
      index: backup.index,
      layout: backup.layout,
      files: updated,
      gameRoot,
    });
    const dirs = buildDirectories(backup.index, updated, gameRoot, {
      tombstones: plan.changes.unlinked.length > 0,
    });
    progress.setFraction(1);

    // 5. Write chunks + index into staging
    progress.setPhase('write', 'Writing the patched archive');
    const staging = await backup.dirHandle.getDirectoryHandle(`.arkham-patch-${Date.now().toString(36)}`, { create: true });
    state.staging = staging;

    const workTotal = Math.max(1, plan.totals.copyBytes * 2 + plan.totals.writeBytes);
    const activityBase = engine.activity.reads + engine.activity.writes;
    const timer = setInterval(() => {
      const done = engine.activity.reads + engine.activity.writes - activityBase;
      progress.setFraction(Math.min(0.995, done / workTotal));
    }, 300);

    let writeResult;
    try {
      writeResult = await writePatch({
        engine,
        plan,
        dirs,
        outDirHandle: staging,
        archive2Size: backup.index.archive2Size,
        shouldCancel: isCancelled,
        onProgress: text => progress.setStatus(text),
        onChunk: info => progress.setDetail(`${info.name} · ${formatBytes(info.total)}`),
      });
    } finally {
      clearInterval(timer);
    }
    progress.setFraction(1);
    checkCancel();

    // 6. Install or prepare the download
    progress.setPhase('install', backup.kind === 'folder' ? 'Copying the patched files to the USB drive' : 'Packaging the patched files');
    if (backup.kind === 'folder') {
      const installTotal = await stagedSize(staging, writeResult.chunkNames);
      let installed = 0;
      await copyStagedToBackup({
        backup,
        staging,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
        onBytes: delta => {
          installed += delta;
          progress.setFraction(installTotal ? installed / installTotal : 0);
          progress.setDetail(`${formatBytes(installed)} of ${formatBytes(installTotal)}`);
        },
      });
      state.result = {
        kind: 'installed',
        plan,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
      };
      // The folder on disk no longer matches the cached index; force a fresh
      // read before another write can be planned.
      state.backup = null;
    } else {
      const archive = await buildBackupZip({
        staging,
        chunkNames: writeResult.chunkNames,
        entry,
        onProgress: (done, total) => {
          progress.setFraction(total ? done / total : 0);
          progress.setDetail(`${formatBytes(done)} of ${formatBytes(total)}`);
        },
      });
      state.result = {
        kind: 'zip',
        blob: archive.blob,
        chunkNames: writeResult.chunkNames,
        newChunkCount: writeResult.newChunkCount,
        plan,
      };
    }

    progress.finish();
    state.patchDone = true;
    state.patchRunning = false;
    wizard.refresh();
  } catch (error) {
    state.patchRunning = false;
    const cancelled = error?.name === 'AbortError' || state.cancelRequested;
    if (state.staging) {
      try {
        await state.backup?.dirHandle?.removeEntry(state.staging.name, { recursive: true });
      } catch {
        // best effort
      }
      state.staging = null;
    }
    if (cancelled) {
      progress.dispose();
      state.patchError = 'The patch was cancelled. The backup was not modified.';
    } else {
      progress.fail(error?.message ?? String(error));
      state.patchError = error?.message ?? String(error);
    }
    state.progress = null;
    wizard.refresh();
  }
}

async function stagedSize(staging, chunkNames) {
  let total = 0;
  for (const name of ['archive.dat', ...chunkNames]) {
    try {
      total += (await (await staging.getFileHandle(name)).getFile()).size;
    } catch {
      // ignore missing archive.dat until it is written
    }
  }
  return total;
}

async function copyStagedToBackup({ backup, staging, chunkNames, newChunkCount, onBytes }) {
  // Chunks first, index last: an interrupted copy never points at missing data.
  for (const name of chunkNames) {
    await copyHandleFile(staging, name, backup.dirHandle, name, onBytes);
  }
  for await (const [name, handle] of backup.dirHandle.entries()) {
    const match = /^archive_(\d+)\.dat$/i.exec(name);
    if (match && Number(match[1]) >= newChunkCount && handle.kind === 'file') {
      await backup.dirHandle.removeEntry(name);
    }
  }
  await copyHandleFile(staging, 'archive.dat', backup.dirHandle, 'archive.dat', onBytes);
  await backup.dirHandle.removeEntry(staging.name, { recursive: true });
  state.staging = null;
}

async function copyHandleFile(sourceDir, sourceName, targetDir, targetName, onBytes) {
  const source = await (await sourceDir.getFileHandle(sourceName)).getFile();
  const writable = await (await targetDir.getFileHandle(targetName, { create: true })).createWritable();
  try {
    for (let offset = 0; offset < source.size; offset += COPY_CHUNK) {
      const end = Math.min(offset + COPY_CHUNK, source.size);
      const buffer = await source.slice(offset, end).arrayBuffer();
      await writable.write(buffer);
      onBytes?.(buffer.byteLength);
    }
  } finally {
    await writable.close();
  }
}

async function buildCoalescedZip(files, entry, onProgress) {
  const coalesced = files.filter(file => isCoalescedName(file.path) && file.path.toUpperCase().includes('/COOKEDPS3/'));
  const total = coalesced.reduce((sum, file) => sum + file.size, 0);
  const readme = [
    'Arkham: Revived - PS3 COALESCED files',
    '',
    `Game: Batman: Arkham Origins (${entry.titleId})`,
    `Copy these files into: dev_hdd0/game/${entry.titleId}/${COALESCED_DIR}`,
    '',
    'Use multiMAN (mmCM) and overwrite the existing files.',
    'Do not delete any other files or folders in that directory.',
    'If the directory does not exist, install the official 1.06 update first.',
  ].join('\n');
  const entries = coalesced.map(file => ({
    path: basename(file.path),
    mtime: new Date(),
    getBlob: async () => file.blob,
  }));
  entries.push({ path: 'README.txt', getBlob: async () => new Blob([readme]) });
  const zip = await buildZip(entries, {
    onProgress: done => onProgress?.({ done: Math.min(total, done), total }),
  });
  return { blob: zip.blob, filenames: coalesced.map(file => basename(file.path)), titleId: entry.titleId };
}

async function buildBackupZip({ staging, chunkNames, entry, onProgress }) {
  const archiveFile = await (await staging.getFileHandle('archive.dat')).getFile();
  let total = archiveFile.size;
  const chunkFiles = [];
  for (const name of chunkNames) {
    const file = await (await staging.getFileHandle(name)).getFile();
    chunkFiles.push({ name, file });
    total += file.size;
  }
  const readme = [
    'Arkham: Revived - patched PS3 backup files',
    '',
    `Game: Batman: Arkham Origins (${entry.titleId})`,
    '',
    '1. Open the backup folder on the USB drive (the one containing archive.dat).',
    '2. Copy archive.dat and the archive_*.dat files from this zip into that folder.',
    '3. Replace the existing files when asked.',
    '4. Do not delete any other file.',
    '',
    `Files in this zip: ${chunkNames.length + 1}`,
    `Rewritten chunks: ${chunkNames.join(', ') || 'none'}`,
  ].join('\n');
  const entries = [
    { path: 'archive.dat', mtime: new Date(), getBlob: async () => archiveFile },
    ...chunkFiles.map(item => ({ path: item.name, mtime: new Date(), getBlob: async () => item.file })),
    { path: 'README.txt', getBlob: async () => new Blob([readme]) },
  ];
  const zip = await buildZip(entries, {
    onProgress: done => onProgress?.(done, total),
  });
  return { blob: zip.blob, chunkNames };
}

/* ------------------------------------------------------------- OFW results */

const ofwResult = {
  id: 'ofw-result',
  title: 'Patched files',
  render() {
    const result = state.result;
    const installed = result?.kind === 'installed';
    const stats = result?.plan
      ? h('ul', { class: 'ak-list' },
        h('li', {}, `${result.plan.changes.added.length.toLocaleString()} files added to the backup`),
        h('li', {}, `${result.plan.replaced.length.toLocaleString()} old entries replaced`),
        h('li', {}, `${result.chunkNames.length} data chunk${result.chunkNames.length === 1 ? '' : 's'} written`),
      )
      : null;

    return h('div', { class: 'ak-page' },
      h('h2', {}, installed ? 'The backup has been patched' : 'Copy the patched files across'),
      installed
        ? h('div', { class: 'ak-status ak-status-ok' },
          h('strong', {}, 'Done - the files were written to the USB drive.'),
          h('p', {}, 'archive.dat and every changed data chunk are in place. Leave the USB drive plugged into this computer until you have read the next step.'),
        )
        : h('div', { class: 'ak-status' },
          h('strong', {}, 'Download the patched files'),
          h('p', {}, 'Copy archive.dat and the archive_*.dat files from the zip into the backup folder on the USB drive, replacing the old files. Keep every other file in that folder.'),
          result?.blob ? h('button', {
            type: 'button',
            class: 'ak-button ak-button-primary',
            onclick: () => downloadBlob(result.blob, `arkham-revived-${state.regionName.toLowerCase()}-${state.editionName.toLowerCase()}-backup.zip`),
          }, `Download patched files (${formatBytes(result.blob.size)})`) : null,
        ),
      stats,
      h('p', { class: 'ak-note' }, 'archive2.dat (copy-protected content) is not touched. If it exists, keep it as it is.'),
    );
  },
};

const ofwRestore = {
  id: 'ofw-restore',
  title: 'Restore the backup',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '10. Restore the backup'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Safely eject the USB drive from this computer, then plug it back into the PS3.'),
        h('li', {}, 'On the PS3, go to ', h('strong', {}, 'Settings'), ' -> ', h('strong', {}, 'System Settings'), ' -> ', h('strong', {}, 'Backup Utility'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Restore"'), ' -> ', h('strong', {}, '"USB Device"'), ' and confirm.'),
        h('li', {}, 'The PS3 reboots. When the restore screen appears, press the ', h('strong', {}, 'PS button'), ' on the controller to continue.'),
        h('li', {}, 'Wait until the restore is completely finished. Do not turn the console off.'),
      ),
      h('p', { class: 'ak-note' }, 'The restore copies the whole backup back, including the patched Arkham Origins game data.'),
    );
  },
};

const ofwSafeMode = {
  id: 'ofw-safe-mode',
  title: 'Enter Safe Mode',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '11. Enter Safe Mode'),
      h('p', {}, 'After the restore, the PS3 needs to rebuild its database. Start by turning the console off and waiting until the red standby light is on.'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Wait until the red standby light is on.'),
        h('li', {}, 'Press and hold the power button. The PS3 beeps once - keep holding.'),
        h('li', {}, 'Keep holding while it beeps a second time, then a third time. Release after the third beep.'),
        h('li', {}, 'Wait until the red light is back.'),
        h('li', {}, 'Press and hold the power button again. It beeps once - keep holding.'),
        h('li', {}, 'Keep holding while it beeps a second time.'),
        h('li', {}, 'Keep holding until it beeps twice quickly, then release.'),
      ),
      h('p', {}, 'The Safe Mode menu should now appear. If it does not, turn the console off and repeat the sequence from the beginning.'),
    );
  },
};

const ofwRebuild = {
  id: 'ofw-rebuild',
  title: 'Rebuild the database',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, '12. Rebuild the database'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Plug the PS3 controller into the console with a USB cable (wireless controllers may not work in Safe Mode).'),
        h('li', {}, 'Press the ', h('strong', {}, 'PS button'), '.'),
        h('li', {}, 'Select ', h('strong', {}, '"Rebuild Database"'), ' and confirm.'),
        h('li', {}, 'The PS3 restarts when it is done.'),
      ),
      h('p', {}, 'The console will ask you to confirm the video mode after restarting. Choose the resolution your TV supports.'),
    );
  },
};

/* --------------------------------------------------------------- CFW pages */

const cfwIntro = {
  id: 'cfw-intro',
  title: 'CFW or HEN',
  render() {
    return h('div', { class: 'ak-page' },
      h('h2', {}, 'CFW or HEN: no backup needed'),
      h('p', {}, 'This page will download the official 1.06 update, decrypt it in memory, and patch every COALESCED file with the Arkham: Revived redirect and the startup movie disabled. You get a zip to copy onto the PS3 with multiMAN (mmCM).'),
      h('div', { class: 'ak-callout' },
        h('strong', {}, 'Before you start'),
        h('ul', { class: 'ak-list' },
          h('li', {}, 'Batman: Arkham Origins and the official 1.06 update must already be installed.'),
          h('li', {}, 'You need about 150 MB free on the PS3 for the files.'),
          h('li', {}, 'Do not delete Arkham: Revived data or any other files in the game folder.'),
        ),
      ),
      h('p', { class: 'ak-note' }, 'This path never reads or writes your PS3 backup.'),
    );
  },
};

const cfwInstall = {
  id: 'cfw-install',
  title: 'Install the zip',
  render() {
    const result = state.result;
    return h('div', { class: 'ak-page' },
      h('h2', {}, 'Copy the patched files with mmCM'),
      result?.blob ? h('button', {
        type: 'button',
        class: 'ak-button ak-button-primary',
        onclick: () => downloadBlob(result.blob, `arkham-revived-${result.titleId}-coalesced.zip`),
      }, `Download COALESCED files (${formatBytes(result.blob.size)})`) : h('p', { class: 'ak-error-text' }, 'The zip has not been built yet.'),
      h('ol', { class: 'ak-list' },
        h('li', {}, 'Copy the zip to a USB drive and plug it into the PS3.'),
        h('li', {}, 'Open ', h('strong', {}, 'multiMAN (mmCM)'), '.'),
        h('li', {}, 'Go to ', h('code', {}, `dev_hdd0/game/${result?.titleId ?? '<TITLEID>'}/${COALESCED_DIR}`), '.'),
        h('li', {}, `Copy the ${result?.filenames?.length ?? ''} COALESCED_*.BIN files from the zip into that folder and choose `, h('strong', {}, 'Yes to All'), ' when asked to overwrite.'),
        h('li', {}, 'Do not delete any other files or folders in that directory. In particular, keep any existing Arkham: Revived data.'),
      ),
      h('p', { class: 'ak-note' }, 'If the folder does not exist, install the official 1.06 update from the PlayStation Store first, then copy the files.'),
    );
  },
};

const cfwFinish = {
  id: 'cfw-finish',
  title: 'Test it',
  render() {
    return finishPage('CFW/HEN');
  },
};

/* ------------------------------------------------------------ final device */

function finishPage(kind) {
  return h('div', { class: 'ak-page' },
    h('h2', {}, 'You are done'),
    h('p', {}, kind === 'CFW/HEN'
      ? 'Arkham Origins is patched. Start the game and try Arkham: Revived Redux.'
      : 'The backup is restored, the database is rebuilt, and Arkham Origins is patched.'),
    h('p', {}, 'Confirm the video mode prompt after the restart if the PS3 shows it.'),
    h('h3', {}, 'Try Arkham: Revived Redux'),
    h('ol', { class: 'ak-list' },
      h('li', {}, 'Sign in to PlayStation Network.'),
      h('li', {}, 'Start Batman: Arkham Origins.'),
      h('li', {}, 'Press ', h('strong', {}, 'Start'), ' at the main menu.'),
      h('li', {}, 'Load a save file.'),
      h('li', {}, 'Select ', h('strong', {}, '"Online"'), ' in the menu.'),
      h('li', {}, 'When online mode has loaded, press ', h('strong', {}, 'Start'), ' again to log in to Arkham: Revived Redux.'),
    ),
    h('div', { class: 'ak-callout' },
      h('strong', {}, 'Troubleshooting'),
      h('ul', { class: 'ak-list' },
        h('li', {}, 'No online option or a failed login? Check that the region and edition match your game.'),
        h('li', {}, 'Nothing changed? Reinstall the official 1.06 update, then run this page again.'),
        h('li', {}, 'Still stuck? Ask in the ', link('https://discord.gg/7BneAcgvZh', 'Arkham: Revived Discord'), '.'),
      ),
    ),
    h('p', { class: 'ak-note' }, 'Server: arkhamrevived.kiwifruitdev.com · Page source and patch tool by KiwifruitDev.'),
  );
}

/* ------------------------------------------------------------------- flow */

function linuxFormatSteps() {
  const steps = [ofwLinuxKnow];
  if (state.pmUsed === null) return steps;
  if (state.pmUsed) {
    steps.push(ofwLinuxManager);
    if (state.linuxManager) steps.push(ofwLinuxGuide);
    return steps;
  }
  for (const probe of [
    { id: 'disks', step: ofwLinuxDisks },
    { id: 'partition', step: ofwLinuxPartition },
    { id: 'gparted', step: ofwLinuxGparted },
  ]) {
    steps.push(probe.step);
    const answer = state.linuxProbes[probe.id];
    if (answer === true) {
      steps.push(ofwLinuxGuide);
      return steps;
    }
    if (answer !== false) return steps;
  }
  steps.push(ofwLinuxDistro);
  if (!state.linuxDistro) return steps;
  steps.push(ofwLinuxInstall, ofwLinuxManager);
  if (state.linuxManager) steps.push(ofwLinuxGuide);
  return steps;
}

function formatSteps() {
  if (state.formatKnown !== false) return [];
  if (state.os === 'windows') {
    return state.rufusUsed === null ? [ofwWindowsKnow] : [ofwWindowsKnow, ofwWindowsGuide];
  }
  if (state.os === 'macos') {
    return state.pmUsed === null ? [ofwMacKnow] : [ofwMacKnow, ofwMacGuide];
  }
  if (state.os === 'linux') return linuxFormatSteps();
  return [];
}

function buildFlow() {
  if (!state.mode) return [firmwareStep];
  if (state.mode === 'cfw') {
    return [firmwareStep, cfwIntro, regionStep, patchStep, cfwInstall, cfwFinish];
  }
  return [
    firmwareStep,
    ofwDrive, ofwSize, ofwOs, ofwFormat,
    ...formatSteps(),
    ofwPlugCheck,
    ofwDelete, ofwBackup, selectStep, regionStep, patchStep,
    ofwResult, ofwRestore, ofwSafeMode, ofwRebuild,
    {
      id: 'ofw-finish',
      title: 'Test it',
      render: () => finishPage('OFW'),
    },
  ];
}

/* --------------------------------------------------------- browser notices */

function openNotice({ title, paragraphs, note, buttonLabel, onClose }) {
  const overlay = h('div', { class: 'ak-modal-backdrop', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'ak-modal' },
      h('h2', {}, title),
      paragraphs.map(text => h('p', {}, text)),
      note ? h('p', { class: 'ak-note' }, note) : null,
      h('div', { class: 'ak-modal-actions' },
        h('button', {
          type: 'button',
          class: 'ak-button',
          onclick: () => {
            overlay.remove();
            document.body.classList.remove('ak-modal-open');
            onClose?.();
          },
        }, buttonLabel),
      ),
    ),
  );
  document.body.classList.add('ak-modal-open');
  document.body.append(overlay);
}

function isChromiumBrowser() {
  const ua = navigator.userAgent || '';
  if (/Firefox\/|FxiOS/.test(ua)) return false;
  return /Chrome\/|Chromium\/|CriOS|Edg\//.test(ua);
}

function showBrowserNotice() {
  if (state.browserAcknowledged) return;
  openNotice({
    title: 'Use Chrome or Edge for this patcher',
    paragraphs: [
      'This page rewrites PS3 backup archives with WebAssembly and needs specific browser features. It is only tested in Chrome, Edge and other Chromium-based browsers such as Opera or Brave.',
      'Firefox and Safari may not be able to select the backup folder or write to the USB drive, and the patch can fail part way through. The CFW/HEN zip and the OFW download usually still work.',
    ],
    note: 'You can continue anyway. If something goes wrong, reopen this page in Chrome or Edge.',
    buttonLabel: 'I understand, continue anyway',
    onClose: () => {
      state.browserAcknowledged = true;
    },
  });
}

function showMobileNotice() {
  if (!state.mobile || state.mobileAcknowledged) return;
  openNotice({
    title: 'Use a computer instead',
    paragraphs: [
      'This patcher reads and rewrites a PS3 Backup Utility archive. A desktop or laptop is strongly recommended: mobile browsers cannot select a folder, cannot write to the USB drive, and may run out of storage while the patch is prepared.',
    ],
    note: 'You can still continue on this device. The CFW/HEN zip works; the OFW backup path will download the patched files instead of writing them.',
    buttonLabel: 'I understand, continue anyway',
    onClose: () => {
      state.mobileAcknowledged = true;
    },
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  root = document.getElementById('arkham-patcher');
  if (!root) return;

  const isolation = await ensureCrossOriginIsolation();
  if (isolation === false) return; // reloading with COOP/COEP
  state.isolated = isolation === true;

  // Browser storage is only a staging area; drop anything a previous visit
  // left behind so a large backup is not blocked by stale copies.
  navigator.storage?.getDirectory?.().then(async opfsRoot => {
    for await (const [name, handle] of opfsRoot.entries()) {
      if (handle.kind === 'directory' && name.startsWith('arkham-ps3-')) {
        await opfsRoot.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  }).catch(() => {});

  root.replaceChildren();
  wizard = new Wizard(root, { canLeave: () => !state.patchRunning });
  wizard.setSteps(buildFlow());
  if (!state.mobile && !state.browserAcknowledged && !isChromiumBrowser()) showBrowserNotice();
  else showMobileNotice();

  if (!state.isolated) {
    console.info('Cross-origin isolation is unavailable; the OFW backup path will be disabled.');
  }
}

boot().catch(error => {
  console.error(error);
  if (root) {
    root.replaceChildren(h('p', { class: 'ak-error-text' }, `The patcher failed to start: ${error.message ?? error}`));
  }
});
