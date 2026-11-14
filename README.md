# servidor-whatsapp

Servidor atual do Achadinhos Automático: WhatsApp/Baileys, Shopee, Mercado Livre,
fila e disparador. O pareamento por telefone foi recuperado como alteração pontual;
o servidor antigo não substitui esta versão.

## API oficial de afiliados Shopee

A instalação pessoal pode fornecer as credenciais da conta pelo ambiente do
backend. O Secret não é enviado ao Chrome nem devolvido pela API; o servidor faz
a assinatura SHA256 e valida as credenciais com `productOfferV2`. Essas
credenciais de ambiente são aceitas somente para uma sessão `personal-device`
autenticada. Contas comerciais continuam usando credenciais próprias cifradas
com AES-256-GCM, vinculadas ao ID gerado pelo servidor.

Antes de iniciar o servidor com a nova integração, configure no ambiente do
backend:

```text
SHOPEE_CREDENTIALS_KEY=<64 caracteres hexadecimais aleatórios, 32 bytes>
SHOPEE_APP_ID=<App ID numérico da conta pessoal>
SHOPEE_SECRET=<Secret da API da conta pessoal>
SHOPEE_BOOTSTRAP_TOKEN=<token de bootstrap do fluxo comercial, se usado>
SHOPEE_ACCOUNT_ADMIN_KEY=<chave administrativa aleatória, 32 bytes em base64url>
SHOPEE_ALLOWED_ORIGINS=chrome-extension://<ID-DA-EXTENSAO>
```

Gere valores aleatórios sem colocá-los no repositório ou na extensão:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use o formato hexadecimal para `SHOPEE_CREDENTIALS_KEY`; ela protege somente as
credenciais individuais armazenadas pelo fluxo comercial. Na instalação
pessoal, `SHOPEE_APP_ID` e `SHOPEE_SECRET` ficam exclusivamente nas variáveis
secretas da Deplexo. O painel da extensão não cadastra esses valores. A
extensão usa o token Bearer pessoal já provisionado e salvo em
`chrome.storage.local`; o backend valida esse token e consulta a Open API. Se o
perfil do Chrome for perdido ou a extensão for instalada novamente sem o token,
a busca permanece desabilitada. Não distribua um token compartilhado nem use
`SEND_KEY` como identidade; provisionar uma nova instalação exige um processo
administrativo seguro fora da extensão.

`SHOPEE_ACCOUNT_ADMIN_KEY` deve ser uma chave aleatória de 32 bytes em base64url
(43 caracteres). A rota `POST /shopee/admin/device/provision` exige essa chave
no cabeçalho `x-shopee-admin-key`, aplica limitação de tentativas e valida as
credenciais configuradas com a GraphQL da Shopee antes de emitir um token
pessoal. Sem chave correta, não cria sessão nem chama a Shopee. A resposta é
`no-store`; o backend grava apenas o hash SHA-256 do token em
`/data/shopee-users.json`. A rota antiga `/shopee/device/enroll` também exige a
chave administrativa além do código de uso único. CORS e ID da extensão não
substituem essa autenticação. Nunca inclua a chave administrativa no código ou
nas configurações da extensão.

Para ativar a extensão após provisionar o token, use o Chrome DevTools na origem
da extensão e abra **Application → Storage → Extension Storage → Local**. Crie
a chave `shopeeDeviceToken` com o token retornado. O Chrome oferece edição da
`chrome.storage` nessa área desde a versão 132. Recarregue a extensão; o popup
valida a sessão no servidor e faz uma consulta GraphQL antes de habilitar a
busca. Se a sessão já existir e estiver válida, não faça novo provisionamento:
isso revoga o token pessoal anterior.

Configure a origem exata da extensão em `SHOPEE_ALLOWED_ORIGINS` (e a origem de
desenvolvimento, se usada). O código de ativação não é uma rota de configuração
nem uma chave administrativa; é aceito apenas uma vez, por HTTPS e com
limitação de tentativas. Os endpoints `/shopee/auth/register`, `/shopee/auth/login`
e convites continuam disponíveis para o futuro fluxo comercial com contas
individuais. O endpoint administrativo de convites usa exclusivamente a chave
do backend, nunca distribuída à extensão.

Os dados persistidos incluem sessões Baileys, fila, configuração do disparador,
tokens OAuth e arquivos Shopee. O volume persistente `/data` não é um backup.
Use a ferramenta administrativa local abaixo para criar um arquivo cifrado; a
chave de backup deve ficar fora do volume e do repositório. A ferramenta não
cria rotas HTTP e não publica arquivos de sessão ou credenciais.

### Backup e restauração administrativa de `/data`

Execute estes comandos no container/host que contém `/data`, em janela de
manutenção, com o disparador pausado e o processo do servidor parado. Gere e
guarde `DATA_BACKUP_KEY` num cofre de segredos, separado do arquivo de backup:

```sh
export DATA_BACKUP_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
umask 077
node scripts/data-volume.mjs export /caminho-seguro/achadinhos-data-$(date -u +%Y%m%dT%H%M%SZ).backup
```

Restaure somente com o servidor parado, a mesma chave fora do backup e depois
de conferir que o arquivo veio de armazenamento confiável. O programa valida a
autenticação AES-GCM antes de alterar `/data`, preserva a versão anterior dentro
do volume em `.before-restore-*` e exige confirmação explícita:

```sh
export DATA_BACKUP_KEY='<mesma chave hexadecimal de 64 caracteres, obtida do cofre>'
node scripts/data-volume.mjs restore /caminho-seguro/achadinhos-data-AAAAMMDDTHHMMSSZ.backup --confirm-volume-replacement
```

Após restaurar, confira a fila, a pasta Baileys selecionada em
`/data/whatsapp-connection.json`, os arquivos de sessão e as configurações antes
de iniciar uma única instância. Não troque nem regenere `SHOPEE_CREDENTIALS_KEY`;
sem a chave original as credenciais Shopee comerciais cifradas não podem ser
abertas. A restauração de um backup antigo também restaura as sessões daquele
instante e pode revogar sessões criadas depois dele.

`/shopee/connection`, `/shopee/teste` e `/shopee/ofertas` exigem token Bearer
emitido pelo backend e nunca confiam em `userId` enviado pelo navegador nem em
`SEND_KEY`. O provisionamento administrativo de dispositivo usa
`SHOPEE_ACCOUNT_ADMIN_KEY`; não faz parte do fluxo comercial. O fluxo individual mantém `/shopee/auth/register` e
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

O `package-lock.json` fixa as dependências e a instalação requer Node.js 20.11 ou
superior. A versão instalada na Deplexo não foi consultada. Os testes simulados
não substituem uma validação posterior com a versão efetiva do ambiente. `npm
start` inicia o servidor real e não deve ser usado para verificação isolada.

### Publicação manual e rollback

Com Auto Deploy desativado, publicar o commit no repositório não reinicia a
Deplexo. Faça a janela de manutenção manualmente: pause o disparador no painel,
gere um backup criptografado como acima, registre o commit atual e publique o
código. No painel da Deplexo selecione **Deploy/Redeploy manual** para o commit
novo e aguarde a verificação de saúde. Não remova nem recrie o volume `/data`;
isso preserva sessões WhatsApp, fila e configurações. Faça smoke checks de
`/status`, conexão WhatsApp e contagem da fila, sem iniciar envios reais.

Se a versão nova falhar, pare o serviço, selecione no painel o commit anterior e
faça novo deploy manual com o mesmo volume `/data`. Não restaure o backup apenas
por falha de código; o rollback de código mantém os dados atuais. Restaure o
backup somente se os próprios dados tiverem sido danificados, sempre com o
servidor parado e usando o procedimento acima. Retome o disparador apenas depois
de confirmar WhatsApp, fila e estado desejado.

Referências oficiais:

- [Baileys: conexão e espera antes do pareamento](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/connecting.md)
- [Baileys: autenticação por código](https://github.com/WhiskeySockets/docs/blob/main/authentication/pairing-code.mdx)
- [Código histórico usado como referência](https://github.com/wowzinho3k-web/servidor-whatsapp/blob/1ffff1e7841665ea2cb098ef1a84ce47f1a99fec/server.js)
