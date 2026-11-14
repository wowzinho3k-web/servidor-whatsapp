# servidor-whatsapp

Servidor atual do Achadinhos Automático: WhatsApp/Baileys, Shopee, Mercado Livre,
fila e disparador. O pareamento por telefone foi recuperado como alteração pontual;
o servidor antigo não substitui esta versão.

## API oficial de afiliados Shopee

A extensão envia App ID e Secret somente ao backend por HTTPS. O Secret não é
gravado no Chrome nem devolvido pela API. O servidor valida as credenciais com
`productOfferV2` e só então grava o Secret cifrado com AES-256-GCM, vinculado ao
ID gerado pelo servidor. A chave de cifragem fica somente em variável de
ambiente. O fluxo comercial usa contas com senha PBKDF2 e sessões temporárias; a
instalação pessoal usa um código de ativação de uso único e token de dispositivo.

Antes de iniciar o servidor com a nova integração, configure no ambiente do
backend:

```text
SHOPEE_CREDENTIALS_KEY=<64 caracteres hexadecimais aleatórios, 32 bytes>
SHOPEE_DEVICE_ENROLLMENT_CODE=<código aleatório de ativação, usado uma vez>
SHOPEE_BOOTSTRAP_TOKEN=<token de bootstrap do fluxo comercial, se usado>
SHOPEE_ACCOUNT_ADMIN_KEY=<token administrativo aleatório>
SHOPEE_ALLOWED_ORIGINS=chrome-extension://<ID-DA-EXTENSAO>
```

Gere valores aleatórios sem colocá-los no repositório ou na extensão:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use o formato hexadecimal para `SHOPEE_CREDENTIALS_KEY`. Para a instalação
pessoal, gere um `SHOPEE_DEVICE_ENROLLMENT_CODE` com 32 bytes aleatórios e
configure-o somente no ambiente do backend; não o inclua na extensão. Na
primeira conexão, o botão pede esse código uma única vez. O servidor valida e
consome o código, cria a identidade do dispositivo e entrega um token aleatório
cujo hash fica no servidor. A extensão conserva esse token em
`chrome.storage.local` para não pedir ativação a cada abertura; o Secret da API
Shopee nunca é salvo no Chrome. A ativação falha se a chave de cifragem não
estiver configurada. A marca de uso é persistida em `/data/shopee-users.json`.
Se o perfil do Chrome for perdido ou a extensão reinstalada, gere um código
novo e substitua `SHOPEE_DEVICE_ENROLLMENT_CODE` no backend antes de reiniciar
o servidor. O novo pareamento revoga o token anterior e mantém as credenciais da
conta pessoal.

Configure a origem exata da extensão em `SHOPEE_ALLOWED_ORIGINS` (e a origem de
desenvolvimento, se usada). O código de ativação não é uma rota de configuração
nem uma chave administrativa; é aceito apenas uma vez, por HTTPS e com
limitação de tentativas. Os endpoints `/shopee/auth/register`, `/shopee/auth/login`
e convites continuam disponíveis para o futuro fluxo comercial com contas
individuais. O endpoint administrativo de convites usa exclusivamente a chave
do backend, nunca distribuída à extensão.

Os dados persistidos ficam em `/data/shopee-users.json` e
`/data/shopee-credentials.json`, ambos gravados com permissão restrita e
substituição atômica. Faça backup de `/data` e mantenha a chave de cifragem fora
desse volume. Perder a chave impede descriptografar os Secrets armazenados.

`/shopee/device/enroll` aceita somente o código pessoal de uso único;
`/shopee/connection`, `/shopee/teste` e `/shopee/ofertas` exigem token Bearer
emitido pelo backend e nunca confiam em `userId` enviado pelo navegador nem em
`SEND_KEY`. O fluxo individual mantém `/shopee/auth/register` e
`/shopee/auth/login`. Rotas Shopee aplicam allowlist CORS separada; a consulta
GraphQL roda no servidor, com credenciais cifradas por identidade autenticada, e
a busca preserva `offerLink` da Shopee.

Esta persistência em JSON foi escolhida para o servidor pessoal atual, que já
usa arquivos em `/data` e uma instância do processo. Para uma oferta comercial
com várias instâncias/alto volume, migrar contas, convites, sessões e credenciais
cifradas para banco transacional e KMS, mantendo o mesmo vínculo por identidade
autenticada. Não use um `userId` informado pelo cliente como autorização.

## Vincular pelo telefone

Procedimento para uso **somente depois de revisar e autorizar a publicação**:

1. Abra a página inicial do servidor em HTTPS.
2. Em **Vincular WhatsApp pelo telefone**, informe a mesma `SEND_KEY` usada pela
   extensão e o número com país e DDD (para Brasil: `55` + DDD + número).
3. Clique em **Gerar código**. O servidor prepara uma sessão nova, aguarda o evento
   QR do Baileys (sem exibir QR) e chama `sock.requestPairingCode(phone)` uma vez.
4. No celular, abra WhatsApp → Aparelhos conectados → Conectar um aparelho →
   Conectar com número de telefone e digite o código mostrado na página.
5. Clique em **Consultar código / conexão** para confirmar a conexão. Esta consulta
   não gera outro código. A página não faz solicitações periódicas de pareamento.
6. A nova vinculação **não libera o disparador**. Use a ação autenticada já existente
   de iniciar ou continuar quando quiser retomar os envios.

O código é mostrado por até 60 segundos como limite local de exposição; isso não
garante a validade no WhatsApp. Após expirar, consulte a conexão antes de pedir
outro. Não é possível gerar outro enquanto conectado, em reconexão com sessão
registrada, durante um envio automático ou com outra solicitação em andamento.

`SEND_KEY` continua sendo obrigatória. A chave é enviada somente no cabeçalho
`x-send-key`, não na URL; a página não a grava em armazenamento do navegador.
O HTML público e `/status` nunca contêm o código. O código é obtido apenas por
consulta autenticada e não é gravado em disco nem registrado nos logs.

## Rotas acrescentadas

- `POST /pair`: cabeçalho `x-send-key: <SEND_KEY>` e JSON `{ "phone": "<número>" }`.
  Também aceita `application/x-www-form-urlencoded` com campo `phone`, usando o
  mesmo cabeçalho de autenticação. Gera código somente mediante essa solicitação.
- `GET /pair`: mesmo cabeçalho, consulta conexão/código vigente sem gerar outro.
- Respostas de pareamento usam `Cache-Control: no-store`. Formato:
  `sucesso`, `conectado`, `status`, `pairingCode`, `expiraEm` (milissegundos Unix)
  e `retomadaManualNecessaria`. Erros usam `sucesso: false` e `erro`.
- `/status` mantém os campos anteriores e acrescenta `whatsapp_status` e
  `retomada_manual_necessaria`, sem dados de autenticação.

Nenhuma rota anterior foi removida. `SEND_KEY`, integrações, conteúdo da fila,
histórico de envios e configuração do disparador são preservados pelo pareamento.

## 401 / loggedOut e preservação de sessões

`DisconnectReason.loggedOut` é o código **401 do Baileys**: a autenticação daquele
dispositivo foi encerrada. Não é o mesmo que o HTTP 401 por `SEND_KEY` inválida.
O código de desconexão sozinho não informa por que a sessão foi encerrada; esta
alteração não inspecionou logs nem credenciais da instalação Deplexo.

Ao receber 401, o servidor bloqueia os envios automáticos, invalida o contexto
da conexão em memória e não tenta reconectar com aquelas credenciais. Não basta
chamar `requestPairingCode` no socket fechado ou mudar `creds.registered`.

Cada nova tentativa explícita de pareamento usa uma pasta exclusiva:

```
/data/baileys-auth-pair-<UUID>/
```

As credenciais e chaves novas são gravadas ali pelo Baileys. A pasta legada
`/data/baileys-auth` e todas as pastas de tentativas anteriores permanecem no lugar;
não há limpeza automática, exclusão de sessões ou chamada a `logout()`.

Um metadado novo, `/data/whatsapp-connection.json`, registra a pasta selecionada,
o estado de invalidação e a necessidade de retomada manual. A atualização usa um
arquivo temporário e substituição atômica **somente desse metadado**. Nos reinícios,
a pasta selecionada é reutilizada; o bloqueio do disparador persiste até uma ação
autenticada e bem-sucedida em `/disparador/iniciar` ou `/disparador/continuar`.
Metadado inválido interrompe a inicialização em vez de selecionar outra sessão.

Sem esse metadado, a sessão legada válida continua sendo usada como antes.
Em todo início do processo (inclusive deploy), os envios automáticos ficam
bloqueados em memória até iniciar/continuar explicitamente, mesmo que a
configuração salva indique um disparador ativo. Isso não altera a fila nem o
histórico e não solicita código de pareamento.
Não remova nem altere o metadado para alternar sessões. Execute uma única instância
do servidor por volume de autenticação; o controle de sockets é local ao processo.

Após vincular, o Baileys pode emitir **515 / restartRequired**. Nesse caso, o
servidor aguarda os salvamentos pendentes e cria outro socket usando a mesma pasta
nova, sem solicitar outro código. Eventos de sockets anteriores são ignorados.

## Verificação sem WhatsApp real

Na pasta deste repositório, com Node.js 20 ou superior:

```
node --check server.js
node --test test/pairing.test.mjs
```

Os testes carregam o servidor com disco, HTTP, relógio e Baileys simulados. Não
instalam dependências, não abrem portas, não acessam `/data` real, não geram códigos
reais e não enviam mensagens. Incluem preservação das rotas/integrações contra o
commit-base `492cfd7a23622c91abe16dddee9a3ed55e2634ff`; por isso precisam do checkout
Git com esse histórico disponível.

`package.json` permanece inalterado e declara Baileys como `latest`, sem lockfile
no repositório. A versão instalada na Deplexo não foi consultada. Os testes simulados
não substituem uma validação posterior com a versão efetiva do ambiente, após
autorização para publicar e vincular. `npm start` inicia o servidor real e não deve
ser usado para essa verificação isolada.

Referências oficiais:

- [Baileys: conexão e espera antes do pareamento](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/connecting.md)
- [Baileys: autenticação por código](https://github.com/WhiskeySockets/docs/blob/main/authentication/pairing-code.mdx)
- [Código histórico usado como referência](https://github.com/wowzinho3k-web/servidor-whatsapp/blob/1ffff1e7841665ea2cb098ef1a84ce47f1a99fec/server.js)
