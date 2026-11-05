import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const config = {
  jwtSecret: 'replace-with-at-least-32-characters-random-secret',
  jwtIssuer: 'quarryvault-dev',
  jwtAudience: 'quarryvault-dev'
};

function signToken(authUserId, sessionId) {
  return jwt.sign(
    {
      sub: authUserId,
      role: 'user',
      client_application: 'android',
      session_id: sessionId,
      sid: sessionId
    },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      issuer: config.jwtIssuer,
      audience: `${config.jwtAudience}:android`,
      expiresIn: '1h'
    }
  );
}

async function testAll() {
  await mongoose.connect('mongodb://localhost:27017/quarryvault');
  const db = mongoose.connection.db;
  const lolo = await db.collection('users').findOne({ username: 'lolo' });
  const min = await db.collection('users').findOne({ username: 'min' });

  const headersLolo = {
    Authorization: `Bearer ${signToken(lolo.auth_user_id, lolo.active_session_id)}`,
    'X-Session-Id': lolo.active_session_id || '',
    'X-Client-Application': 'android'
  };

  const headersMin = {
    Authorization: `Bearer ${signToken(min.auth_user_id, min.active_session_id)}`,
    'X-Session-Id': min.active_session_id || '',
    'X-Client-Application': 'android'
  };

  const quarryId = 'aba142db-4de8-4b0f-af19-4326a3dfffda';
  const docId = 'ea64ccb9-0439-431b-bd9c-e4329664defd';

  console.log('--- 1. GET /quarries/:id/documents ---');
  const resDocs = await fetch(`http://localhost:8000/quarries/${quarryId}/documents`, { headers: headersMin });
  console.log('MIN docs status:', resDocs.status);
  const docsData = await resDocs.json();
  console.log('MIN docs data:', docsData);

  console.log('--- 2. GET /documents/:id/view ---');
  const resView = await fetch(`http://localhost:8000/documents/${docId}/view`, { headers: headersMin });
  console.log('MIN view doc status:', resView.status);
  if (resView.status !== 200) console.log('MIN view error:', await resView.text());

  console.log('--- 3. GET /documents/:id/download ---');
  const resDl = await fetch(`http://localhost:8000/documents/${docId}/download`, { headers: headersMin });
  console.log('MIN download doc status:', resDl.status);
  if (resDl.status !== 200) console.log('MIN download error:', await resDl.text());

  console.log('--- 4. LOLO view and download ---');
  const resViewLolo = await fetch(`http://localhost:8000/documents/${docId}/view`, { headers: headersLolo });
  console.log('LOLO view doc status:', resViewLolo.status);
  if (resViewLolo.status !== 200) console.log('LOLO view error:', await resViewLolo.text());

  const resDlLolo = await fetch(`http://localhost:8000/documents/${docId}/download`, { headers: headersLolo });
  console.log('LOLO download doc status:', resDlLolo.status);
  if (resDlLolo.status !== 200) console.log('LOLO download error:', await resDlLolo.text());

  console.log('--- 5. Company Admin (LOLO) Create Quarry ---');
  const resCreateQuarry = await fetch('http://localhost:8000/quarries', {
    method: 'POST',
    headers: { ...headersLolo, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-quarry-by-lolo', quarry_number: '999', quarry_type: 'جرانيت' })
  });
  console.log('LOLO create quarry status:', resCreateQuarry.status);
  console.log('LOLO create quarry body:', await resCreateQuarry.text());

  console.log('--- 6. Company Admin (LOLO) Get Employees ---');
  const resEmps = await fetch('http://localhost:8000/company/employees', { headers: headersLolo });
  console.log('LOLO get employees status:', resEmps.status);
  console.log('LOLO get employees body:', await resEmps.text());

  console.log('--- 7. Employee (MIN) Create Quarry (should be forbidden or allowed?) ---');
  const resCreateQuarryMin = await fetch('http://localhost:8000/quarries', {
    method: 'POST',
    headers: { ...headersMin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-quarry-by-min', quarry_number: '998', quarry_type: 'جرانيت' })
  });
  console.log('MIN create quarry status:', resCreateQuarryMin.status);
  console.log('MIN create quarry body:', await resCreateQuarryMin.text());

  await mongoose.disconnect();
}

testAll().catch(console.error);
