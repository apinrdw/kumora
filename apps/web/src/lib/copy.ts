// Every string the landing page shows, in English and Indonesian. The
// Indonesian is a draft for the owner's review.
export type Lang = "en" | "id"

export const COPY = {
  en: {
    title: "KUMORA AI: see who is buying",
    description:
      "Every IDX trade with the broker on each side, foreign or domestic. Join the waitlist.",
    switchTo: "Bahasa Indonesia",
    switchLabel: "Baca dalam Bahasa Indonesia",
    signIn: "Sign in",
    hasAccess: "Already have access?",
    hook: "See who is buying. Line by line.",
    lede: "KUMORA prints every trade on the Indonesia Stock Exchange with the broker on each side, and whether each one is foreign or domestic. Follow the money that moves the price.",
    emailLabel: "Email",
    emailPlaceholder: "you@example.com",
    join: "Take a queue number",
    joining: "Printing your number…",
    privacy:
      "We use your email only to let you in when your number comes up. No newsletter.",
    errorInvalid: "That email doesn't look right. Check it and try again.",
    errorServer:
      "The queue machine didn't answer. Your email wasn't saved. Try again in a moment.",
    ticketTitle: "Your queue number",
    ticketJoined: "You're in the queue. We'll email you when it's your turn.",
    ticketAlready: "This email is already in the queue. Here is its number.",
    ticketTaken: "Taken",
    formCode: "Form KM-01 · Waitlist slip",
    ledgerTitle: "BBRI · 10 Nov 2026",
    recorded: "Recorded",
    colTime: "Time",
    colPrice: "Price",
    colLots: "Lots",
    colBuyer: "Buyer",
    colSeller: "Seller",
    bigTrade: "Big trade",
    ledgerCaption:
      "Every BBRI trade of 10 November 2026 from 09:01:48 to 09:02:00 WIB, replayed from KUMORA's recorded day. [F] foreign, [D] domestic.",
    ledgerSummary:
      "318 BBRI trades in 12 seconds. Broker AK, foreign, bought in two lots worth more than Rp1 billion each.",
    printHead: "Printing",
    saldoHeading: "In twelve seconds, one foreign broker took 22,328 lots.",
    saldoBody:
      "Add up each broker's buys and sells on the same twelve seconds and the book balances like a passbook. AK, a foreign broker, bought most of what domestic brokers sold.",
    saldoCaption:
      "Net lots of BBRI per broker, 09:01:48 to 09:02:00 WIB, 10 November 2026. Recorded day.",
    colBroker: "Broker",
    colNet: "Net lots",
    colValue: "Net value",
    netBuyer: "Net buyer",
    netSeller: "Net seller",
    indexHeading: "What else is in the book",
    indexBody:
      "The tape is the first page. Your access opens the rest of the terminal.",
    index: [
      {
        name: "Market Live",
        body: "The running trade with brokers on every line, a footprint chart of each minute, and sweeps drawn over the order book.",
      },
      {
        name: "Sweep alerts",
        body: "A sound and a mark on the tape when a sweep is among the top 1% of that stock's day.",
      },
      {
        name: "Order book radar",
        body: "Walls absorbed, eaten or reloaded, and the heavy side of each book, across the market.",
      },
      {
        name: "Market Bubbles",
        body: "Every stock in one live map, sized and coloured by its buying and selling, grouped by sector.",
      },
      {
        name: "Holdings",
        body: "Who holds a stock, from IDX and KSEI reports: major holders, foreign and local, and how it changed.",
      },
    ],
    closeHeading: "Your number, please.",
    closeBody:
      "Access opens in queue order. Take a number now and keep your place.",
    disclaimer:
      "KUMORA shows what happened on the exchange. It is not investment advice and does not tell anyone to buy or sell.",
    dataNote:
      "Trades above are from KUMORA's own recording of the IDX tape, shown as recorded.",
  },
  id: {
    title: "KUMORA AI: lihat siapa yang membeli",
    description:
      "Setiap transaksi di BEI lengkap dengan broker di kedua sisi, asing atau domestik. Ambil nomor antrean.",
    switchTo: "English",
    switchLabel: "Read in English",
    signIn: "Masuk",
    hasAccess: "Sudah punya akses?",
    hook: "Lihat siapa yang membeli. Baris demi\u00a0baris.",
    lede: "KUMORA mencetak setiap transaksi di Bursa Efek Indonesia beserta broker di kedua sisi, dan apakah masing-masing asing atau domestik. Ikuti uang yang menggerakkan harga.",
    emailLabel: "Email",
    emailPlaceholder: "anda@contoh.com",
    join: "Ambil nomor antrean",
    joining: "Mencetak nomor Anda…",
    privacy:
      "Email Anda hanya kami pakai untuk memberi akses saat nomor Anda tiba. Tanpa newsletter.",
    errorInvalid: "Email itu sepertinya keliru. Periksa lalu coba lagi.",
    errorServer:
      "Mesin antrean tidak menjawab. Email Anda belum tersimpan. Coba lagi sebentar lagi.",
    ticketTitle: "Nomor antrean Anda",
    ticketJoined:
      "Anda sudah masuk antrean. Kami akan mengirim email saat giliran Anda.",
    ticketAlready: "Email ini sudah ada di antrean. Ini nomornya.",
    ticketTaken: "Diambil",
    formCode: "Formulir KM-01 · Slip antrean",
    ledgerTitle: "BBRI · 10 Nov 2026",
    recorded: "Rekaman",
    colTime: "Waktu",
    colPrice: "Harga",
    colLots: "Lot",
    colBuyer: "Pembeli",
    colSeller: "Penjual",
    bigTrade: "Transaksi besar",
    ledgerCaption:
      "Setiap transaksi BBRI pada 10 November 2026 pukul 09:01:48 sampai 09:02:00 WIB, diputar ulang dari rekaman hari KUMORA. [F] asing, [D] domestik.",
    ledgerSummary:
      "318 transaksi BBRI dalam 12 detik. Broker AK, asing, membeli dua kali dengan nilai lebih dari Rp1 miliar masing-masing.",
    printHead: "Mencetak",
    saldoHeading:
      "Dalam dua belas detik, satu broker asing mengambil 22.328 lot.",
    saldoBody:
      "Jumlahkan beli dan jual setiap broker pada dua belas detik yang sama, dan buku ini seimbang seperti buku tabungan. AK, broker asing, membeli sebagian besar yang dijual broker domestik.",
    saldoCaption:
      "Lot bersih BBRI per broker, 09:01:48 sampai 09:02:00 WIB, 10 November 2026. Hari rekaman.",
    colBroker: "Broker",
    colNet: "Lot bersih",
    colValue: "Nilai bersih",
    netBuyer: "Pembeli bersih",
    netSeller: "Penjual bersih",
    indexHeading: "Isi buku selanjutnya",
    indexBody:
      "Running trade adalah halaman pertama. Akses Anda membuka seluruh terminal.",
    index: [
      {
        name: "Market Live",
        body: "Running trade dengan broker di setiap baris, footprint chart per menit, dan sweep di atas order book.",
      },
      {
        name: "Sweep alert",
        body: "Bunyi dan tanda di running trade saat sebuah sweep masuk 1% teratas saham itu hari ini.",
      },
      {
        name: "Order book radar",
        body: "Wall yang diserap, dimakan, atau diisi ulang, dan sisi berat setiap order book, di seluruh pasar.",
      },
      {
        name: "Market Bubbles",
        body: "Setiap saham dalam satu peta langsung, diukur dan diwarnai dari pembelian dan penjualannya, dikelompokkan per sektor.",
      },
      {
        name: "Kepemilikan",
        body: "Siapa pemegang sebuah saham, dari laporan BEI dan KSEI: pemegang utama, asing dan lokal, serta perubahannya.",
      },
    ],
    closeHeading: "Nomor Anda, silakan.",
    closeBody:
      "Akses dibuka sesuai urutan antrean. Ambil nomor sekarang dan simpan tempat Anda.",
    disclaimer:
      "KUMORA menampilkan apa yang terjadi di bursa. Ini bukan saran investasi dan tidak menyuruh siapa pun membeli atau menjual.",
    dataNote:
      "Transaksi di atas berasal dari rekaman running trade BEI milik KUMORA, ditampilkan apa adanya.",
  },
} as const

export type Copy = (typeof COPY)[Lang]
