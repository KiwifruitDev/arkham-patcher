// Static data shared by the tutorial page, the patcher and the test scripts.

export const PKG_BASE = '/arkhamrevived/ps3/';

// The title updates are hosted next to the page (same origin), because Sony's
// CDN still serves them over plain HTTP without CORS headers.
export const REGIONS = [
  {
    key: 'us-disc',
    titleId: 'BLUS31147',
    region: 'US',
    edition: 'Disc',
    file: 'UP1018-BLUS31147_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg',
    size: 72945376,
  },
  {
    key: 'us-digital',
    titleId: 'NPUB31261',
    region: 'US',
    edition: 'Digital',
    file: 'UP1018-NPUB31261_00-BATMANARKHAMORIG-A0106-V0100-PE.pkg',
    size: 72946336,
  },
  {
    key: 'eu-disc',
    titleId: 'BLES01784',
    region: 'Europe',
    edition: 'Disc',
    file: 'EP1018-BLES01784_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg',
    size: 73880784,
  },
  {
    key: 'eu-digital',
    titleId: 'NPEB01414',
    region: 'Europe',
    edition: 'Digital',
    file: 'EP1018-NPEB01414_00-BATMANORIGINS001-A0106-V0100-PE.pkg',
    size: 73881744,
  },
  {
    key: 'br-disc',
    titleId: 'BLUS31207',
    region: 'Brazil',
    edition: 'Disc',
    file: 'UP1018-BLUS31207_00-BATMANORIGIPATCH-A0106-V0100-PE.pkg',
    size: 63620208,
  },
  {
    key: 'br-digital',
    titleId: 'NPUB31264',
    region: 'Brazil',
    edition: 'Digital',
    file: 'UP1018-NPUB31264_00-BATMANARKHAMORIG-A0106-V0100-PE.pkg',
    size: 63621168,
  },
];

export const REGION_NAMES = ['US', 'Europe', 'Brazil'];
export const EDITION_NAMES = ['Disc', 'Digital'];

export function regionFor(region, edition) {
  return REGIONS.find(item => item.region === region && item.edition === edition) ?? null;
}

export function pkgUrl(entry) {
  return `${PKG_BASE}${entry.file}`;
}

export const GAME_DIR = titleId => `/dev_hdd0/game/${titleId}`;
export const COALESCED_DIR = 'USRDIR/MULTIPLAYER/PATCH/BMGAME/COOKEDPS3';
export const COALESCED_PATH = titleId => `${GAME_DIR(titleId)}/${COALESCED_DIR}`;
