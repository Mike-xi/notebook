import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const site = new URL('../../review-site/', import.meta.url);
const courses = JSON.parse(await readFile(new URL('courses.json', site), 'utf8'));
const starpost = courses.find((course) => course.file === 'starpost');

assert.ok(starpost, 'Starpost course should be listed');
assert.equal(starpost.category, 'explore');
assert.equal(starpost.link, '/starpost');
assert.equal(starpost.icon, '/assets/icons/starpost.svg');

const wrapper = await readFile(new URL('starpost.html', site), 'utf8');
assert.match(wrapper, /https:\/\/notebook-chat\.xiaxi0694\.workers\.dev\//);
assert.match(wrapper, /allow="microphone; clipboard-write"/);

await access(new URL('assets/icons/starpost.svg', site));
console.log(JSON.stringify({ ok: true, courses: courses.length, starpost: starpost.title }));
