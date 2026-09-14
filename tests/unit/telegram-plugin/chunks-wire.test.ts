import {chunkText, htmlToPlain} from '../../../src/telegram/chunks';

test('balanced HTML chunks never split entities or emoji pairs',()=>{
  const plain='😀<&> '.repeat(2000);
  const html='<pre><code>'+plain.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</code></pre>';
  const parts=chunkText(html,1900,true);
  expect(parts.map(htmlToPlain).join('')).toBe(plain);
  for(const part of parts){
    expect(part.length).toBeLessThanOrEqual(1900);
    expect(part).not.toMatch(/&(?:amp|lt|gt)?<\//);
    expect(part.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,'')).not.toMatch(/[\uD800-\uDFFF]/);
  }
});
