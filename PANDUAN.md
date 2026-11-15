# Panduan memasang Ruang Obrol (Vercel + Firebase)

## Isi folder
| File | Fungsi |
|---|---|
| `index.html` | Website chat (satu file) |
| `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | Agar bisa dipasang di layar utama dan menampilkan notifikasi |
| `api/auth.js` | Masuk dan daftar (cek Cloudflare Turnstile, batas percobaan) |
| `api/moderation.js` | Kirim, edit, hapus, lapor pesan, dan semua aksi admin |
| `api/admin-accounts.js` | Membuat dan menghapus akun sementara (belum dipanggil dari tampilan, hanya lewat permintaan API dari admin) |
| `api/cleanup-expired.js` | Tugas harian: hapus akun sementara yang habis masa berlakunya dan bersihkan catatan batas percobaan |
| `lib/firebase-admin.js` | Penghubung server ke Firebase (bukan endpoint) |
| `vercel.json` | Jadwal tugas harian dan header keamanan |

Rules database tidak ada di folder ini. Tempel langsung di Firebase Console (langkah 4).

## 1. Firebase
1. Buat project di https://console.firebase.google.com, tambahkan aplikasi web, salin `firebaseConfig`.
2. Authentication → Sign-in method → aktifkan **Email/Password**.
3. Realtime Database → Create Database (lokasi Singapore) → **locked mode**.
4. Realtime Database → tab **Rules** → tempel Rules milikmu → **Publish**. Ganti email admin di Rules dengan emailmu.
5. Project settings → **Service accounts** → **Generate new private key**. Isi file JSON itu dipakai di langkah 3.

## 2. Isi `index.html`
Cari bagian `ISI BAGIAN INI`, isi `firebaseConfig`, `TURNSTILE_SITE_KEY`, dan `ADMIN_EMAILS`.

## 3. Deploy ke Vercel
Upload folder ini ke GitHub lalu impor di Vercel. Tambahkan Environment Variables:

| Nama | Isi | Wajib |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Seluruh isi file JSON service account | Ya |
| `TURNSTILE_SECRET_KEY` | Secret key Cloudflare Turnstile | Ya |
| `CRON_SECRET` | Teks acak panjang, dipakai Vercel untuk tugas harian | Ya |
| `ADMIN_EMAILS` | Email admin dipisah koma (harus sama dengan di `index.html` dan Rules) | Disarankan |
| `FIREBASE_DATABASE_URL` | URL Realtime Database, kalau berbeda dari bawaan | Tidak |
| `FIREBASE_API_KEY` | Web API key Firebase, kalau berbeda dari bawaan | Tidak |
| `MANAGED_ACCOUNT_EMAIL_DOMAIN` | Domain email akun sementara, bawaan `akun.ruang-obrol.app` | Tidak |

Setelah mengubah Environment Variables, lakukan Redeploy. Di Firebase Console → Authentication → Settings → **Authorized domains**, tambahkan domain Vercel-mu.

## 4. Pemakaian pertama
1. Buka website, tekan **Daftar** dengan email adminmu, lalu verifikasi lewat email.
2. Tombol **Admin** muncul di atas. Pengguna lain mendaftar dengan cara yang sama.

## Kalau ada masalah
| Gejala | Penyebab dan solusi |
|---|---|
| "Server belum dikonfigurasi" | `TURNSTILE_SECRET_KEY` atau `FIREBASE_SERVICE_ACCOUNT` belum diisi, atau belum Redeploy. |
| "Server tidak punya izin membuat token login" | Service account salah, atau API IAM Service Account Credentials belum aktif di Google Cloud. |
| "Izin ditolak" saat membaca data | Rules belum dipublish, atau email admin di Rules tidak sama dengan `ADMIN_EMAILS`. |
| Tombol Admin tidak muncul | Email daftar tidak sama persis dengan `ADMIN_EMAILS`. |
| Login gagal di domain sendiri | Domain belum ada di Authorized domains. |
| Tugas harian tidak jalan | `CRON_SECRET` belum diisi. |
