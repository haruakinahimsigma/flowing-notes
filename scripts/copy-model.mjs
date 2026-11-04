import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('node_modules/@spotify/basic-pitch/model');
const destination = resolve('public/model');
await mkdir(resolve('public'), { recursive: true });
await cp(source, destination, { recursive: true });
console.log('Copied Spotify Basic Pitch model assets.');
