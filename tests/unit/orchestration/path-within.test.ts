import path from 'path';
import { pathWithin } from '../../../src/utils/paths';

// The shared-project guard (runtime.ts, tasks/driver.ts) and the skill resource
// checks rely on this. Runs natively on Linux, macOS and Windows in CI.
describe('pathWithin', () => {
  test('POSIX: the root itself and descendants only', () => {
    const p = path.posix;
    expect(pathWithin('/a/ws', '/a/ws', p)).toBe(true);
    expect(pathWithin('/a/ws', '/a/ws/project', p)).toBe(true);
    expect(pathWithin('/a/ws', '/a/ws-other', p)).toBe(false);
    expect(pathWithin('/a/ws', '/a', p)).toBe(false);
    expect(pathWithin('/a/ws', '/a/ws/../x', p)).toBe(false);
    expect(pathWithin('/a/ws', '/a/ws/..foo', p)).toBe(true); // a name starting with "..", not a parent
    expect(pathWithin('/a/ws', '/A/WS/project', p)).toBe(false); // POSIX is case-sensitive
  });
  test('Windows: backslashes, any letter case, and other drives', () => {
    const w = path.win32;
    expect(pathWithin('C:\\Users\\me\\ws', 'C:\\Users\\me\\ws\\project', w)).toBe(true);
    expect(pathWithin('C:\\Users\\me\\ws', 'c:\\users\\ME\\WS\\project', w)).toBe(true);
    expect(pathWithin('C:\\Users\\me\\ws', 'C:\\Users\\me\\WS', w)).toBe(true);
    expect(pathWithin('C:\\Users\\me\\ws', 'C:\\Users\\me\\ws-other', w)).toBe(false);
    expect(pathWithin('C:\\Users\\me\\ws', 'C:\\Users\\me', w)).toBe(false);
    expect(pathWithin('C:\\Users\\me\\ws', 'D:\\Users\\me\\ws\\project', w)).toBe(false);
  });
  test('the host API is the default', () => {
    const root = path.resolve('ws');
    expect(pathWithin(root, path.join(root, 'project'))).toBe(true);
    expect(pathWithin(path.join(root, 'project'), root)).toBe(false);
  });
});
