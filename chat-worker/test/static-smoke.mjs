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
assert.match(wrapper, /src="\/starpost-app\/"/);
assert.match(wrapper, /href="\/starpost-app\/"/);
assert.doesNotMatch(wrapper, /workers\.dev/);
assert.match(wrapper, /allow="microphone; clipboard-write"/);

const chatScript = await readFile(new URL('../public/chat.js', import.meta.url), 'utf8');
assert.match(chatScript, /const APP_BASE = location\.pathname/);
assert.match(chatScript, /fetch\(appPath\(path\)/);
assert.match(chatScript, /appPath\(`\/ws\//);
assert.match(chatScript, /prepareAvatar/);
assert.match(chatScript, /onlineUsers/);

const chatStyles = await readFile(new URL('../public/chat.css', import.meta.url), 'utf8');
assert.match(chatStyles, /\.chat-app \{[^}]*grid-template-rows: minmax\(0,1fr\);[^}]*overflow: hidden;/s);
assert.match(chatStyles, /\.conversation \{[^}]*min-height: 0;[^}]*overflow: hidden;/s);
assert.match(chatStyles, /\.conversation-active \{[^}]*height: 100%;[^}]*overflow: hidden;/s);

const chatPage = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(chatPage, /id="online-button"/);
assert.doesNotMatch(chatPage, /id="online-button"[^>]*hidden/);
assert.match(chatPage, /id="avatar-input"/);

await access(new URL('assets/icons/starpost.svg', site));
await access(new URL('functions/starpost-app/[[path]].js', site));
console.log(JSON.stringify({ ok: true, courses: courses.length, starpost: starpost.title }));
