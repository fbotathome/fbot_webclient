# Labeler: dataset da competição pelo webclient

A página **Labeler** faz o fluxo inteiro de um dataset de segmentação, do Steam Deck e sem terminal:

1. **Fotos:** tira as fotos com a câmera ligada no aparelho que abriu a página. Sem câmera no navegador, usa a câmera do robô.
2. **Roboflow:** sobe as fotos para o Roboflow, onde você anota os polígonos.
3. **Treino:** baixa o dataset anotado e treina um YOLO de segmentação.
4. **Rotulagem automática:** o modelo anota as fotos novas, e a página sobe essas fotos já anotadas para você só revisar no Roboflow.

Quem faz o trabalho é o `ros_nodes/labelerNode.py`, na máquina que roda o `scripts/start.sh`. Treino e rotulagem rodam no `ros_nodes/labelerTrain.py`, e as chamadas ao Roboflow ficam no `ros_nodes/roboflowClient.py`.

---

## 1. Preparação (uma vez, antes de viajar)

**Projeto no Roboflow**
- Crie um projeto do tipo **Instance Segmentation**. Os outros tipos não servem: Object Detection só tem caixas, e o treino precisa de polígonos.
- Dê às classes nomes em snake_case (ex.: `red_cup`). O Roboflow normaliza os nomes no export.
- No plano gratuito, o projeto fica **público** (licença CC BY 4.0, aparece no Roboflow Universe).

**Chave e projeto:** em `~/.config/fbot_webclient/roboflow.env`, fora desta pasta, porque o webclient serve esta pasta na rede.

```
ROBOFLOW_API_KEY=<Private API Key: app.roboflow.com → Settings → API Keys>
ROBOFLOW_PROJECT=<id do projeto na URL: app.roboflow.com/<workspace>/<projeto>/...>
ROBOFLOW_WORKSPACE=
```

O node lê esse arquivo a cada uso, então não precisa reiniciar nada depois de editar. Deixe `ROBOFLOW_WORKSPACE` vazio para usar o workspace da própria chave.

**Pesos base do YOLO:** baixe antes, porque na arena a internet é ruim.

```bash
mkdir -p ~/labeler_fotos/_models && cd ~/labeler_fotos/_models && python3 -c "from ultralytics import YOLO; YOLO('yolo11n-seg.pt')"
```

**Máquina:** o treino precisa de GPU para ser rápido. Rode o `start.sh` no notebook. O robô sem GPU treina, mas muito devagar.

**Teste no Steam Deck:**
1. Abra `https://<ip-do-notebook>:8080` no Deck e aceite o aviso do certificado.
2. Veja se a página libera a câmera ligada no Deck. Isso ainda **não foi verificado** no navegador do Steam.
3. Se não liberar, a página usa a câmera do robô (`/femtobolt/color/image_raw`).

**Internet:** o Roboflow precisa de internet. Leve um plano B, como o hotspot de um celular.

---

## 2. Subir e abrir

```bash
source ~/fbot_ws/install/setup.zsh
bash ~/fbot_ws/src/fbot_webclient/scripts/start.sh                    # sozinho na rede
ROS_DOMAIN_ID=42 POWER_MACHINE=none bash ~/fbot_ws/src/fbot_webclient/scripts/start.sh   # notebook com o robô ligado
LAUNCH_CAMERA=1 bash ~/fbot_ws/src/fbot_webclient/scripts/start.sh    # Femto Bolt ligada direto no PC
```

- **Dois `start.sh` na mesma rede ROS:** se o robô também roda o `start.sh` no mesmo `ROS_DOMAIN_ID`, cada clique é atendido duas vezes (tasks, pick, desligar). Pare o do robô ou isole o notebook, como na segunda linha.
- **Endereço:** abra o que o script mostra em `Access:`, `https://<ip>:8080`. Um `http://` é redirecionado para `https://`.
- **Certificado:** é autoassinado, gerado em `~/.config/fbot_webclient/`, um por IP. No primeiro acesso, clique em **Advanced…** e depois em **Accept the Risk and Continue**. Isso vale uma vez por navegador e por IP, e `localhost` conta como um endereço separado.
- **Página Labeler:** a linha do Roboflow deve mostrar `Project: <projeto>`, e o status deve dizer `Live · this device's camera` (ou `Live · robot camera`).

---

## 3. Passo a passo na competição

### Passo 1: fotos de demonstração (rodada `demo`)
1. Escolha a rodada **demo**. Fotografe os objetos novos: vários por foto, nos móveis da arena, de ângulos, distâncias e com luzes diferentes.
2. Mande mais ou menos 1 foto em cada 5 para **Valid**.
3. Salve na galeria: **Select** → **Select all** → **Save**. Salve sempre, porque as fotos pendentes se perdem se o webclient reiniciar.
4. Clique em **Send round**.

### Passo 2: anotar no site do Roboflow
1. Em **Annotate**, desenhe os polígonos com o **Smart Polygon** (um clique no objeto e você ajusta).
2. Anote **todos** os objetos da lista que aparecem em cada foto. Um objeto sem polígono ensina ao modelo que aquilo é fundo.
3. Adicione as fotos anotadas ao dataset (**Add to Dataset**). As fotos que sobem pela API ficam na fila de anotação, e uma versão só leva as que estão no dataset.

### Passo 3: treinar
1. Na página, clique em **New version**, que gera a versão no Roboflow e baixa o dataset.
2. Escolha a versão (ex.: `v1`), as épocas (padrão 50) e clique em **Train**.
3. Espere o job terminar como `done`. O modelo leva o nome da versão. Treinar de novo a mesma versão só troca o modelo quando o treino termina: um treino cancelado ou que falhou mantém o modelo anterior.

### Passo 4: rotular o lote automaticamente
1. Crie a rodada **lote**: **New round** → `lote` → **Add**. Tire e salve muitas fotos.
2. Escolha o modelo e clique em **Label round**.
3. Clique em **Send with labels**. As fotos sobem já anotadas pelo modelo.
4. No Roboflow, revise as fotos: corrija ou complete os polígonos e apague os erros. Depois clique em **Add to Dataset**.

### Passo 5: repetir
Clique em **New version**, depois em **Train** com o dataset maior, e rotule a próxima rodada (`lote2`, ...). Cada volta deixa o modelo melhor e diminui o que você corrige à mão.

### No fim
- **Detector do robô:** o dataset revisado no Roboflow é o que serve para treinar o detector que o robô usa na prova. O Labeler não faz esse treino; o modelo dele é só para anotar mais rápido.
- **Backup:** copie `~/labeler_fotos` (pendrive ou outro PC) a cada sessão.

---

## 4. Para que serve cada botão

| Controle | O que faz |
|---|---|
| **Capture** | Tira uma foto e guarda como pendente, só na memória. O flash só pisca quando o node confirma. |
| **Round** (seletor) | A rodada (pasta de fotos) em uso. O número é quantas fotos salvas ela tem. Galeria e envios valem para ela. |
| **New round + Add** | Cria uma rodada (letras, números, `_` e `-`). A pasta nasce no primeiro Save. |
| **Train / Valid** | Em que split entram as **próximas** fotos. |
| **Captured** | Fotos da rodada em cada split, somando as salvas e as pendentes. |
| **Send round** | Sobe as fotos salvas que ainda não subiram. Clicar de novo não duplica. |
| **Send with labels** | Sobe as fotos e as anotações do **Label round**. Nunca sobrescreve uma foto que já tem anotação no Roboflow. |
| **New version** | Gera uma versão nova no Roboflow e baixa o dataset. |
| **Get latest** | Baixa a última versão que já existe (ex.: uma gerada no site). |
| **Dataset + épocas + Train** | Treina o YOLO de segmentação nessa versão. |
| **Modelo + Label round** | Anota todas as fotos salvas da rodada com o modelo. As anotações ficam na máquina até o Send with labels. |
| **Job** (título, log, **Cancel**) | O que está rodando, o estado e as últimas linhas. Cancel interrompe o job. |
| **Select / Select all / Save** | Na galeria: marca as pendentes e grava no disco. Segurar o dedo numa foto também entra na seleção. |
| **Discard unsaved** | Joga fora todas as pendentes da rodada. Para tirar uma foto só, salve as boas e descarte o resto. |

Só roda um job por vez (envio, download, treino ou rotulagem). Enquanto ele roda, os outros botões ficam travados. Os botões do Roboflow ficam desabilitados enquanto o `roboflow.env` não estiver preenchido.

---

## 5. Onde ficam os arquivos

```
~/labeler_fotos/
  <rodada>/train/<timestamp>.jpg, <rodada>/valid/...   fotos salvas (só imagens)
  _versions/v<N>/          dataset baixado do Roboflow (export yolov8)
  _models/v<N>/weights/best.pt   modelo treinado na versão N; os pesos base também ficam em _models/
  _labels/<rodada>/        anotações COCO que o modelo fez, uma por foto
  _roboflow/<rodada>.json  o que já subiu (id de cada foto no Roboflow)
~/.config/fbot_webclient/
  roboflow.env             chave e projeto
  webclient-<ip>.crt/.key  certificado do HTTPS
```

---

## 6. Problemas comuns

| Sintoma | Causa e o que fazer |
|---|---|
| Página em branco | O `start.sh` não está rodando, ou o endereço está errado. Use `https://<ip>:8080`. |
| "Something doesn't look right" no Firefox | É o certificado autoassinado. Clique em **Advanced…** → **Accept the Risk and Continue**. |
| `Not set up: add ROBOFLOW_API_KEY…` | Preencha o `~/.config/fbot_webclient/roboflow.env` e recarregue a página. |
| Status `Live · robot camera` no Deck | O navegador não liberou a câmera. Veja a permissão de câmera do navegador. |
| `Câmera parada` ao capturar | Faz mais de 2 s que a câmera do robô não manda frame. Veja o driver ou o Isaac. |
| Status preso em `Capturing…` | O labeler node não respondeu. Veja o terminal do `start.sh`. |
| `Version N has no images` | Faltou o **Add to Dataset** no Roboflow. Faça isso e clique em **New version** de novo. |
| Treino cai por memória (CUDA out of memory) | Outro programa está usando a GPU (ex.: Isaac Sim). Feche-o, ou treine depois. |
| Muitos `RTPS_TRANSPORT_SHM Error` no terminal | Aviso do FastDDS, que cai para UDP. A comunicação funciona. |

Mensagens de erro do Roboflow aparecem no log do job, com a chave escondida (`***`).
