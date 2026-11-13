# Panduan memasang Ruang Obrol

## Isi folder
| File | Fungsi |
|---|---|
| `index.html` | Website chat (satu file, siap dipakai) |
| `firebase-rules.json` | Aturan keamanan database |
| `firebase.json` | Pengaturan untuk upload lewat Firebase Hosting |
| `preview.html` | Contoh tampilan tanpa Firebase (opsional, boleh dihapus) |
| `PANDUAN.md` | Panduan ini |

## 1. Buat project Firebase
1. Buka https://console.firebase.google.com lalu klik **Add project**. Nama bebas, Google Analytics boleh dimatikan.
2. Di halaman project, klik ikon **</>** (Web) untuk menambah aplikasi web. Beri nama, tidak perlu centang Hosting dulu.
3. Firebase menampilkan blok `firebaseConfig`. Salin isinya.

## 2. Isi konfigurasi di index.html
Buka `index.html`, cari bagian `ISI BAGIAN INI`, lalu:
- Ganti isi `firebaseConfig` dengan yang kamu salin. Pastikan ada `databaseURL`. Kalau tidak muncul, buat dulu Realtime Database (langkah 4), lalu ambil URL-nya.
- Ganti `ADMIN_EMAILS` dengan email adminmu, contoh: `["emailkamu@gmail.com"]`.

## 3. Aktifkan login email
Firebase Console → **Authentication** → **Get started** → tab **Sign-in method** → **Email/Password** → aktifkan → **Save**.

## 4. Buat database
Firebase Console → **Realtime Database** → **Create Database**. Pilih lokasi terdekat (misalnya Singapore), pilih **locked mode**.

## 5. Pasang Rules
1. Buka `firebase-rules.json`, ganti **semua** `emailadminkamu@gmail.com` dengan email adminmu (harus sama persis dengan di `ADMIN_EMAILS`).
2. Di Realtime Database buka tab **Rules**, hapus isinya, tempel isi file tadi, lalu klik **Publish**.

## 6. Upload website
Website harus dibuka lewat alamat `https://`, tidak bisa lewat file yang diklik langsung dari HP atau komputer.

**Cara A: Firebase Hosting**
```
npm install -g firebase-tools
firebase login
firebase use --add        # pilih project-mu
firebase deploy
```
Selesai, Firebase memberi alamat `https://NAMA-PROJECT.web.app`.

**Cara B: hosting lain** (Netlify, GitHub Pages, domain sendiri)
Upload `index.html` saja. Lalu di Firebase Console → Authentication → **Settings** → **Authorized domains** → **Add domain**, tambahkan domain hosting itu. Kalau lupa, login akan gagal.

## 7. Cara pakai pertama kali
1. Buka website, tekan **Daftar**, pakai email adminmu (email asli).
2. Buka email, klik link verifikasi (cek folder spam), lalu kembali dan tekan **Saya sudah verifikasi**.
3. Tombol **Admin** akan muncul di atas. Pengguna lain mendaftar dengan cara yang sama.
4. Setelah masuk sekali, website otomatis login lagi setiap dibuka, selama kamu tidak menekan **Keluar**.

## Fitur
- Chat realtime: teks, foto (dikompres otomatis), file maksimal sekitar 700 KB.
- Ubah nama: tekan namamu di pojok atas. Nama baru tampil di semua pesan lama juga.
- Admin: hapus pesan siapa pun, lihat daftar pengguna, blokir dan buka blokir.

## Kalau ada masalah
| Gejala | Penyebab dan solusi |
|---|---|
| "Izin ditolak" saat kirim chat | Rules belum dipublish, email admin di Rules tidak sama dengan di `index.html`, atau email belum terverifikasi. Keluar lalu masuk lagi setelah verifikasi. |
| Tombol Admin tidak muncul | Email yang daftar tidak sama persis dengan isi `ADMIN_EMAILS`. |
| Login gagal di domain sendiri | Domain belum ada di Authorized domains (langkah 6B). |
| Email verifikasi tidak datang | Cek spam, atau tekan **Kirim ulang email**. |
| Halaman kosong | Dibuka lewat file langsung. Buka lewat alamat `https://`. |
| Foto atau file gagal terkirim | Ukuran terlalu besar. Untuk file lebih besar perlu Firebase Storage. |
