import { describe, expect, it } from 'vitest';
import { MENU_MAX_WIDTH, menuX } from './PopupMenu';

describe('where a floating menu goes across', () => {
  it('opens from the button when there is room, and leftwards from its right edge near the window edge', () => {
    expect(menuX(100, 180, 1300)).toEqual({ left: 100 });
    expect(menuX(1090, 1174, 1300)).toEqual({ right: 126 });
    expect(menuX(1300 - MENU_MAX_WIDTH - 8, 1000, 1300)).toEqual({ left: 1300 - MENU_MAX_WIDTH - 8 });
  });
});
