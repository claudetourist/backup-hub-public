import { describe, expect, it } from 'vitest';
import { categoryOf, SEARCH_CATEGORIES } from './fileCategories';
import { categoryOfKind, FILE_KINDS, isFileKind, kindOf, kindsOfCategory, KIND_LABELS } from './fileKinds';

const kind = (relPath: string, mime: string | null = null): string => kindOf(relPath, relPath.slice(relPath.lastIndexOf('/') + 1), mime);

describe('kindOf photos and videos', () => {
  it('WhatsApp wins over screenshots and camera', () => {
    expect(kind('D:/Phone/WhatsApp/Media/WhatsApp Images/IMG-20200101-WA0001.jpg')).toBe('photo-whatsapp');
    expect(kind('D:/x/IMG-20200101-WA0042.jpg')).toBe('photo-whatsapp');
    expect(kind('D:/x/whatsapp stuff/Screenshot_1.png')).toBe('photo-whatsapp');
    expect(kind('D:/DCIM/Camera/WhatsApp Video 2020.mp4')).toBe('video-whatsapp');
    expect(kind('D:/x/VID-20200101-WA0003.mp4')).toBe('video-whatsapp');
  });

  it('screenshots come before camera, for photos only', () => {
    expect(kind('D:/x/Screenshot (3).png')).toBe('photo-screenshot');
    expect(kind('D:/x/Screen Shot 2020-01-01.png')).toBe('photo-screenshot');
    expect(kind('D:/Pictures/Screenshots/a.png')).toBe('photo-screenshot');
    expect(kind('D:/DCIM/Screenshots/IMG_0001.jpg')).toBe('photo-screenshot');
    expect(kind('D:/Pictures/Screenshots/clip.mp4')).toBe('video-other');
  });

  it('camera: DCIM or Camera folder, or a camera file name', () => {
    expect(kind('D:/Phone/DCIM/Camera/a.jpg')).toBe('photo-camera');
    expect(kind('D:/x/dcim/100ANDRO/a.jpg')).toBe('photo-camera');
    expect(kind('D:/x/PXL_20230101_101010.jpg')).toBe('photo-camera');
    expect(kind('D:/x/img-0001.heic')).toBe('photo-camera');
    expect(kind('D:/x/DSCN1234.jpg')).toBe('photo-other'); // no separator: not a camera name by the rule
    expect(kind('D:/x/IMG_abc.jpg')).toBe('photo-other');
    expect(kind('D:/x/VID_20200101.mp4')).toBe('video-camera');
    expect(kind('D:/Camera/clip.mov')).toBe('video-camera');
    expect(kind('D:/x/holiday.mp4')).toBe('video-other');
    expect(kind('D:/x/holiday.png')).toBe('photo-other');
  });

  it('a folder named Camera only counts as a whole folder name, and the file name is not a folder', () => {
    expect(kind('D:/x/Cameras/a.jpg')).toBe('photo-other');
    expect(kind('D:/x/a/Camera')).toBe('other');
    expect(kind('D:/x/dcim.jpg')).toBe('photo-other');
  });

  it('path comparison ignores case and accepts either slash', () => {
    expect(kind('d:/PHONE/dcim/CAMERA/A.JPG')).toBe('photo-camera');
    expect(kindOf('D:\\Phone\\DCIM\\a.jpg', 'a.jpg', null)).toBe('photo-camera');
  });
});

describe('kindOf audio and the rest', () => {
  it('voice recordings by folder or by name, other audio is music', () => {
    expect(kind('D:/Phone/Recordings/a.m4a')).toBe('audio-recording');
    expect(kind('D:/Phone/Voice Recorder/a.mp3')).toBe('audio-recording');
    expect(kind('D:/Phone/Sound recorder/a.amr')).toBe('audio-recording');
    expect(kind('D:/Phone/Call/a.amr')).toBe('audio-recording');
    expect(kind('D:/x/Recording 12.m4a')).toBe('audio-recording');
    expect(kind('D:/x/voice_note.opus')).toBe('audio-recording');
    expect(kind('D:/x/Call-Mom.amr')).toBe('audio-recording');
    expect(kind('D:/x/rec_001.wav')).toBe('audio-recording');
    expect(kind('D:/x/record.mp3')).toBe('audio-music');
    expect(kind('D:/x/Recorded live.mp3')).toBe('audio-music');
    expect(kind('D:/Music/song.mp3')).toBe('audio-music');
  });

  it('documents, Google Docs, archives and everything else follow the category', () => {
    expect(kind('D:/x/a.pdf')).toBe('documents');
    expect(kind('My Drive/Notes', 'application/vnd.google-apps.document')).toBe('google-docs');
    expect(kind('D:/x/a.zip')).toBe('archives');
    expect(kind('D:/x/setup.iso')).toBe('archives');
    expect(kind('D:/x/blob.xyz')).toBe('other');
    expect(kind('D:/x/noext')).toBe('other');
  });

  it('uses the mime type when the extension says nothing', () => {
    expect(kind('My Drive/DCIM/pic', 'image/jpeg')).toBe('photo-camera');
    expect(kind('My Drive/clip', 'video/mp4')).toBe('video-other');
    expect(kind('My Drive/memo', 'audio/mpeg')).toBe('audio-music');
  });
});

describe('the kind list', () => {
  it('has a plain label and one category for every kind, and every category has a kind', () => {
    expect(KIND_LABELS['photo-screenshot']).toBe('Screenshots');
    expect(KIND_LABELS.other).toBe('Everything else');
    for (const k of FILE_KINDS) {
      expect(KIND_LABELS[k].length).toBeGreaterThan(0);
      expect(isFileKind(k)).toBe(true);
      expect(kindsOfCategory(categoryOfKind(k))).toContain(k);
    }
    for (const c of SEARCH_CATEGORIES) expect(kindsOfCategory(c).length).toBeGreaterThan(0);
    expect(isFileKind('nope')).toBe(false);
    expect(isFileKind(null)).toBe(false);
  });
});

// A small deterministic random generator so a failing case can be replayed.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('kindOf agrees with categoryOf', () => {
  it('for 50,000 random paths, names, extensions and mime types', () => {
    const next = rng(42);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    const exts = ['jpg', 'JPG', 'png', 'heic', 'mp4', 'MOV', 'mkv', 'mp3', 'm4a', 'amr', 'pdf', 'docx', 'txt', 'zip', 'iso', 'xyz', 'exe', '', 'ts', 'x.y'];
    const folders = ['DCIM', 'Camera', 'WhatsApp', 'WhatsApp Images', 'Screenshots', 'Recordings', 'Call', 'Voice Recorder', 'Music', 'a', 'My Drive', 'D:'];
    const bases = ['IMG_0001', 'PXL_2020', 'VID-123', 'IMG-20200101-WA0001', 'Screenshot 1', 'Screen Shot x', 'Recording 1', 'voice_1', 'call-1', 'rec 2', 'song', 'x', '.hidden', 'a b', ''];
    const mimes = [null, null, null, 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain', 'application/zip', 'application/vnd.google-apps.document', 'application/octet-stream', 'IMAGE/PNG'];
    for (let i = 0; i < 50_000; i += 1) {
      const depth = Math.floor(next() * 4);
      const parts: string[] = [];
      for (let d = 0; d < depth; d += 1) parts.push(pick(folders));
      const ext = pick(exts);
      const name = `${pick(bases)}${ext === '' ? '' : `.${ext}`}`;
      parts.push(name);
      const relPath = parts.join('/');
      const mime = pick(mimes);
      const got = kindOf(relPath, name, mime);
      expect(categoryOfKind(got), `${relPath} ${String(mime)}`).toBe(categoryOf(name, mime));
    }
  }, 60_000);
});

describe('kindOf camera file names outside DCIM', () => {
  it.each(['0I2A1030.JPG', '5D4_1234.CR2', 'IMG_E1234.JPG', '_MG_4567.JPG', 'DSC01234.JPG', 'P1010123.JPG', 'DJI_0123.JPG', '20230101_123456.jpg', '2023-01-01 12.34.56.jpg'])('%s is a camera photo', (name) => {
    expect(kind(`D:/Pics/Trip/${name}`)).toBe('photo-camera');
  });
  it.each(['GOPR0123.MP4', 'GH010123.MP4', 'C0001.MP4', 'DJI_0456.MP4', '20230101_123456.mp4'])('%s is a camera video', (name) => {
    expect(kind(`D:/Vids/${name}`)).toBe('video-camera');
  });
  it('does not take ordinary names, screenshots or WhatsApp for camera files', () => {
    expect(kind('D:/Pics/holiday plan 2023.jpg')).toBe('photo-other');
    expect(kind('D:/Pics/Screenshot_20230101_123456.png')).toBe('photo-screenshot');
    expect(kind('D:/Pics/IMG-20230101-WA0001.jpg')).toBe('photo-whatsapp');
    expect(kind('D:/Pics/logo_final.png')).toBe('photo-other');
  });
});
