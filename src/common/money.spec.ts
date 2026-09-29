import { parseMoneyCents } from './money';

describe('parseMoneyCents', () => {
  it.each([
    [0, 0],
    ['12', 1200],
    ['12.3', 1230],
    ['1.005', 101],
    [1.005, 101],
    ['1.004', 100],
    ['1.999', 200],
    ['1e3', 100000],
    ['1e-7', 0],
    ['21474836.47', 2_147_483_647],
  ])('converts %s to %i integer cents', (input, expected) => {
    expect(parseMoneyCents(input)).toBe(expected);
  });

  it.each([-1, '-0.01', '21,50', '21474836.48', 'not-a-price', null, true])(
    'rejects invalid or out-of-range amount %s',
    (input) => expect(parseMoneyCents(input)).toBeUndefined(),
  );
});
