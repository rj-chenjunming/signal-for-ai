import { expect, it } from 'vitest';
import { resolveCanvasSize } from '../src/main/overlay-layout';
it('docked tools have room for 32 DIP targets and long lists stay in work area', () => {
  const three = resolveCanvasSize(28, 3, 600, 'right');
  expect(three.height).toBeGreaterThanOrEqual(4 * 32);
  expect(three.width).toBeGreaterThanOrEqual(32 + 12);
  expect(resolveCanvasSize(28, 100, 300, 'right').height).toBeLessThanOrEqual(300);
  const top = Reflect.apply(resolveCanvasSize, null, [28, 100, 300, 'top', 400]);
  expect(top.width).toBeLessThanOrEqual(400);
});
