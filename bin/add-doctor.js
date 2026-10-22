// bin/add-doctor.js
// Skrip CLI untuk mendaftarkan akun dokter spesialis kulit
// Penggunaan: node bin/add-doctor.js "Nama Dokter" "STR/SIP" "Instansi" "Password"
// Atau: npm run add-doctor

const readline = require('readline');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../server/db');

const args = process.argv.slice(2);

async function createDoctor(nama, str_sip, instansi, password) {
  if (!nama || !str_sip || !instansi || !password) {
    console.error('❌ Data tidak lengkap!');
    console.log('Format: node bin/add-doctor.js "<Nama Dokter>" "<STR/SIP>" "<Instansi>" "<Password>"');
    process.exit(1);
  }

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    const id = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO doctors (id, nama, str_sip, instansi, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, nama.trim(), str_sip.trim(), instansi.trim(), password_hash);

    console.log('\n========================================');
    console.log('✅ AKUN DOKTER BERHASIL DITAMBAHKAN:');
    console.log('ID       :', id);
    console.log('Nama     :', nama);
    console.log('STR / SIP:', str_sip);
    console.log('Instansi :', instansi);
    console.log('========================================');
    console.log('Dokter kini dapat masuk melalui URL: /dokter\n');
  } catch (err) {
    console.error('❌ Gagal menambahkan dokter:', err.message);
  }
}

if (args.length >= 4) {
  createDoctor(args[0], args[1], args[2], args[3]);
} else {
  // Mode interaktif prompt jika argumen tidak langsung diberikan
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('--- PENDAFTARAN AKUN DOKTER PENILAI ---');
  rl.question('Nama Lengkap Dokter (dengan gelar): ', (nama) => {
    rl.question('Nomor STR / SIP                  : ', (str_sip) => {
      rl.question('Instansi / Rumah Sakit / Klinik  : ', (instansi) => {
        rl.question('Kata Sandi (Password)            : ', async (password) => {
          rl.close();
          await createDoctor(nama, str_sip, instansi, password);
        });
      });
    });
  });
}
