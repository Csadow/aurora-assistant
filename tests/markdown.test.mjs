import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

test('renderer preserves code literally and links only real source references',()=>{
  const source={id:'M1',path:'Profile/About me.md'};
  const html=renderMarkdown('A fact [M1]. Unknown [M9].\n\n```html\n<script>alert(1)</script> [M1]\n```',[source]);
  assert.match(html,/data-note="Profile\/About me.md"/);assert.match(html,/Unknown \[M9\]/);assert.match(html,/<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt; \[M1\]<\/code><\/pre>/);
});
test('renderer never reinterprets source IDs inside link URLs as HTML',()=>{
  const html=renderMarkdown('[external](https://example.com/[M1]) [[About me|Profile]]\n\n<img src=x onerror="alert(1)">',[{id:'M1',path:'note.md'}]);
  assert.match(html,/href="https:\/\/example.com\/\[M1\]"/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/data-wiki="About me"/);
});
test('renderer supports headings, lists, bold text and quoted malicious link attributes',()=>{
  const html=renderMarkdown('# Title\n\n1. **One**\n2. Two\n\n[x](https://example.com/"onmouseover="evil)');
  assert.match(html,/<h2>Title<\/h2>/);assert.match(html,/<ol><li><strong>One<\/strong><\/li><li>Two<\/li><\/ol>/);assert.match(html,/&quot;onmouseover=&quot;/);assert.doesNotMatch(html,/"onmouseover="/);
});
