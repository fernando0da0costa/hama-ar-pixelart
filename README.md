# Hama AR — monte contas Hama com as próprias mãos, na webcam

Protótipo pra disciplina TEMTC-CII (Computação Imersiva Inteligente). Ideia: usar
rastreamento de mão (MediaPipe HandLandmarker) numa webcam comum pra "pinçar"
continhas coloridas de uma bandeja virtual e encaixá-las na cor certa de um
desenho — pinça do polegar com o indicador pra pegar uma cor da paleta
flutuante e encaixar na célula certa, tudo desenhado como marca d'água sobre
o vídeo da câmera.

## Fluxo do app

```
[Boas-vindas]          [Menu do jogo]                    [Jogo]
Animação de       →    Câmera já ligada. Aponta      →   Monta a forma da
"carregando"            o dedo pro joguinho (Hama /        categoria escolhida
enquanto confere        Matemática / Montar palavras)      com a mão, via
suporte à câmera        e segura ~1s pra escolher —        webcam
                        sem clicar em nada
```

Sem tela de configuração no meio — é pra ser um joguinho, não um sistema. A
mesma sessão de câmera/rastreamento de mão do menu (`webcam-scene.js`,
`startMenu`) é reaproveitada quando o jogo começa (`startWebcam`).

Cada joguinho do menu usa uma lista de formas diferente (mesmo esquema de
bitmap de contas), definida em `js/shapes/*.js`:

- **Jogar Hama** — formas decorativas (`shapes/basic.js`): coração, estrela,
  círculo, etc.
- **Matemática** — números (`shapes/numbers.js`), um de cada vez.
- **Montar palavras** — alfabeto completo A-Z (`shapes/letters.js`), uma
  letra de cada vez.

Dentro de cada categoria o jogo é por fases: das formas prontas, ordenadas da
mais fácil pra mais difícil pelo número de contas, avançando pra próxima
sozinho quando o desenho atual é completado 100% certo (progresso salvo em
`js/progress.js`/localStorage).

```
js/main.js escolhe a próxima forma não completada da categoria
(js/shapes/*.js) ── currentPattern ──→ js/webcam-scene.js (three.js)
                                          → getUserMedia + MediaPipe
                                            HandLandmarker
                                          → paleta 3D de esferas coloridas
                                          → grade de "furos-fantasma"
                                            (cor alvo) sobre o vídeo
                                          → pinça (polegar↔indicador) perto
                                            de uma célula: encaixa e valida
                                            (verde = igual ao alvo,
                                            vermelho = errou)
```

Um passo natural de evolução (bom pra `A2.2`/`A2.3`) é um classificador de
gesto mais robusto (hoje é geometria pura, distância 2D entre landmarks) ou
uma sugestão adaptativa de próxima célula a montar.

`js/pattern.js` (quantização de cor k-means pra gerar um padrão a partir de
uma foto) fica no repo mas não é mais chamado por `main.js` — o fluxo de
"subir uma foto minha" foi removido da tela pra simplificar a experiência
(virar um joguinho direto, sem tela de configuração); a função continua
pronta pra ser plugada de volta se fizer sentido depois.

## Requisitos de hardware/navegador — leia antes de testar

- Precisa de uma webcam comum (notebook ou celular) e de um navegador com
  `getUserMedia` — funciona em qualquer Chrome/Firefox/Safari recentes, sem
  headset e sem exigir HTTPS além do necessário pra câmera.
- Em celular, só existe a câmera frontal por padrão; o botão "🔄 Trocar
  câmera" alterna pra traseira quando o aparelho tiver as duas.

## Como rodar localmente

Precisa de contexto seguro (HTTPS ou `localhost`) por causa da câmera:

```bash
cd hama-ar
python3 -m http.server 8080
```

Abra `http://localhost:8080` no navegador.

## Estrutura

```
hama-ar/
├── index.html          # boas-vindas + shell do menu (câmera) + shell do jogo
├── style.css
├── js/
│   ├── pattern.js       # (não usado no momento) imagem → grade de contas, k-means
│   ├── webcam-scene.js  # getUserMedia + MediaPipe: menu por gesto, pinça, encaixe
│   ├── bead-geometry.js # geometria 3D da conta (tubo furado), compartilhada
│   ├── shapes/
│   │   ├── basic.js     # formas do jogo "Hama"
│   │   ├── numbers.js   # formas do jogo "Matemática"
│   │   ├── letters.js   # formas do jogo "Montar palavras"
│   │   └── shape-utils.js
│   ├── progress.js      # localStorage: fases completadas
│   ├── sound.js
│   └── main.js          # liga menu/webcam-scene, progressão por fases
└── README.md
```

## Limitações conhecidas (honestas, pra citar no relatório)

- Sem profundidade real: a câmera olha de frente pro vídeo, então a
  interação é 2D (mão sobre o vídeo), não ancorada no mundo real como RA
  imersiva de verdade seria — trade-off aceito pra rodar em qualquer
  aparelho, sem headset.
- Pinça é detectada por limiar fixo de distância 2D entre `thumb-tip` e
  `index-finger-tip` (fração da largura do vídeo) — sensível a ruído de
  tracking e à distância da mão até a câmera.
- Sem persistência de sessão: sair do jogo no meio de um desenho perde o
  progresso daquele desenho (as fases já completadas continuam salvas).
- A seleção do menu por gesto (apontar e segurar ~1,1s) usa só a ponta do
  indicador da primeira mão detectada — sem exigir pinça, mas também sem
  distinguir "apontando de propósito" de "mão passando por ali"; clique do
  mouse funciona como alternativa.
- "Matemática" e "Montar palavras" hoje só montam números/letras avulsos —
  não há ainda problema de conta (soma) nem sequência de palavra completa.
- O recurso de subir uma foto própria (upload/recorte/paleta automática)
  ficou fora do fluxo principal por enquanto — ver nota em "Estrutura" acima.
