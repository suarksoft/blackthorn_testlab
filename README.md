# DeltaG TestLab (Next.js)

Bu klasor, mevcut `deltag-testlab` Vite projesinin Next.js (App Router) tabanli surumudur.

## Calistirma

```bash
npm install
npm run dev
```

Varsayilan uygulama adresi:

- `http://127.0.0.1:3200`

## API Proxy

Istemci istekleri `/api/*` altindan backend'e yonlendirilir.

- Varsayilan hedef: `http://127.0.0.1:8080`
- Ortam degiskeni ile degistir: `API_TARGET`

Ornek:

```bash
API_TARGET=http://127.0.0.1:9000 npm run dev
```

## Durum

- Next.js projesi olusturuldu
- Solana ve wallet bagimliliklari eklendi
- `/api/[...path]` route handler ile backend proxy hazirlandi
- `deltag-testlab/src/App.tsx` ekrani `src/components/TestLabApp.tsx` olarak tasindi
- Eski stil yapisi `src/app/globals.css` icine tasindi

# blackthorn_testlab
