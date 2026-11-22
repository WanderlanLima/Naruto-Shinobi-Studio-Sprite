# Shinobi Sprite Studio

Extrator, visualizador Spine e estúdio offline de sprites, partículas, auras passivas, vídeos MP4 e áudios/vozes MP3 — com suporte a **Backup Offline em `.zip`** (leitura direta via `File.slice()`, sem descompactar tudo na RAM) e **qualidade máxima nativa (1:1)** em todas as exportações.

## Rodar localmente (com servidor Node completo)

**Pré-requisito:** Node.js 20+ (recomendado Node 22)

```bash
npm install
npm run dev
```

Abra `http://localhost:3000`.

> No modo local (`npm run dev`), tanto a leitura offline quanto a geração em streaming de backups `.zip` completos/modulares/personalizados funcionam normalmente.

## Publicar no GitHub e no GitHub Pages

Este projeto já inclui o workflow automático em `.github/workflows/deploy-pages.yml` e a configuração de caminhos relativos (`base: './'`) + `.nojekyll`.

### 1. Subir o projeto para o GitHub

Crie um repositório vazio no GitHub (ex.: `shinobi-sprite-studio`) e execute na pasta do projeto:

```bash
git init
git branch -M main
git add .
git commit -m "Deploy inicial do Shinobi Sprite Studio"
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

### 2. Ativar o GitHub Pages

1. No repositório do GitHub, acesse **Settings → Pages**.
2. Em **Build and deployment → Source**, selecione **GitHub Actions**.
3. Aguarde a aba **Actions** concluir o workflow **Deploy to GitHub Pages** (leva cerca de 1 a 2 minutos).
4. Sua aplicação ficará publicada em:
   `https://SEU_USUARIO.github.io/SEU_REPOSITORIO/`

### Como usar o Modo Offline no GitHub Pages

O GitHub Pages hospeda o site de forma 100% estática (sem servidor Node):
- **Leitura direta de backups `.zip`:** funciona 100% no GitHub Pages (inclusive no Android). Basta abrir a aba **Backup Offline** e selecionar o(s) arquivo(s) `.zip` salvos no seu dispositivo.
- **Gerar novos backups em streaming:** como o streaming de ZIP exige o servidor Node, basta gerar e baixar os arquivos `.zip` pelo ambiente local (`npm run dev`) e depois carregá-los sempre que quiser no seu site do GitHub Pages.
