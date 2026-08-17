# Hama AR — monte contas Hama no ar, com as próprias mãos

Protótipo pra disciplina TEMTC-CII (Computação Imersiva Inteligente). Ideia: gerar
um padrão de contas Hama/Perler a partir de uma foto (like o
[Pixel-art-web](../Pixel-art-web)) e depois "pendurar" esse padrão como um quadro
virtual fixado no mundo real via **WebXR (immersive-ar + hit-test)**, montando-o
com **rastreamento de mão nativo do WebXR** (XRHand) — pinça do polegar com o
indicador pra pegar uma cor da paleta flutuante e encaixar na célula certa.

## Arquitetura (resumo)

```
[Tela de setup, 2D]                         [Sessão immersive-ar]
Upload de imagem                             Hit-test → fixa o quadro no mundo real
   ↓ recorte + resolução + paleta            XRHand (21 juntas/mão) → pinça detectada
js/pattern.js                                geometricamente (dist. polegar↔indicador)
  → quantização de cor (k-means, "IA leve")     ↓
  → grade w×h de {cor, nome Hama}            js/ar-scene.js (three.js + WebXR)
                                                → paleta 3D de esferas coloridas
   currentPattern ──────────────────────────→   → grade de "furos-fantasma" (cor alvo)
                    js/main.js (glue)            → ao pinçar perto de uma célula com
                                                    uma cor na mão: preenche e valida
                                                    (verde = igual ao alvo, vermelho = errou)
```

O componente "inteligente" hoje é a quantização de cor (k-means simplificado)
que reduz a foto a uma paleta pequena — é o que torna a foto administrável em
poucas cores de contas de verdade. Um passo natural de evolução (bom pra
`A2.2`/`A2.3`) é trocar/complementar isso por um classificador de gesto mais
robusto (hoje é geometria pura, distância 3D entre juntas) ou por sugestão
adaptativa de próxima célula a montar.

## Requisitos de hardware/navegador — leia antes de testar

- **`immersive-ar` com `hand-tracking` de verdade, hoje, na prática, só existe
  bem suportado no Meta Quest Browser** (Quest 2/3/Pro, com "Rastreamento de
  mãos" ativado nas configurações do sistema do headset).
- **Celular com Chrome/ARCore** tem `immersive-ar` (WebXR) mas **não** expõe
  `XRHand` — não há rastreamento de mão real em AR de celular hoje. Se
  `hand-tracking` não estiver disponível, o app ainda entra em RA e fixa o
  quadro (hit-test funciona em celular normalmente), mas a interação por
  pinça não funciona — isso é uma limitação de plataforma, não do código, e
  vale citar como limitação conhecida no relatório.
- Desktop sem headset: `navigator.xr.isSessionSupported('immersive-ar')`
  retorna `false` e o botão "Entrar em RA" fica desabilitado — dá pra testar
  só a parte de geração do padrão (tela de setup).

## Como rodar localmente

Precisa de contexto seguro (HTTPS ou `localhost`) por causa de câmera/WebXR:

```bash
cd hama-ar
python3 -m http.server 8080
```

Abra `http://localhost:8080` no navegador do computador pra testar a tela de
setup (upload, recorte, paleta, prévia).

### Testar a parte de RA no Quest

O Quest precisa acessar o servidor rodando na sua máquina, então
`localhost` não serve — ele precisa de HTTPS válido apontando pro IP da sua
rede. Duas opções simples:

1. **Túnel HTTPS** (mais fácil): `npx ngrok http 8080` (ou `cloudflared tunnel
   --url http://localhost:8080`) e abra a URL gerada no navegador do Quest.
2. **mkcert** na rede local: gerar certificado local confiável e servir com
   `https://` no IP da sua máquina, com o Quest na mesma rede Wi-Fi.

## Estrutura

```
hama-ar/
├── index.html        # tela de setup (upload/recorte/paleta) + shell da tela de RA
├── style.css
├── js/
│   ├── pattern.js     # imagem → grade de contas (k-means + paleta Hama), sem DOM
│   ├── ar-scene.js     # WebXR: hit-test, quadro 3D, paleta 3D, hand-tracking, pinça
│   └── main.js         # liga a UI de setup ao ar-scene.js
└── README.md
```

## Limitações conhecidas (honestas, pra citar no relatório)

- Não testado em headset real ainda — escrito a partir da WebXR Device API e
  dos exemplos oficiais do three.js (`webxr_ar_hittest`,
  `webxr_vr_handinput_*`); pode ter ajustes de escala/gesto necessários na
  primeira sessão real.
- Pinça é detectada por limiar fixo de distância 3D entre `thumb-tip` e
  `index-finger-tip` (2,8 cm) — sensível a ruído de tracking; pode precisar de
  suavização (média móvel) depois de testar em headset real.
- Sem persistência: sair da sessão de RA perde o progresso da montagem.
- Só a paleta Hama fixa (24 cores) faz sentido fisicamente pra comprar contas
  reais; o modo "automática" é mais pra prévia/exportação PNG.
