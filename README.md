# servidor-whatsapp

Servidor atual do Achadinhos Automático: WhatsApp/Baileys, Shopee, Mercado Livre,
fila e disparador. O pareamento por telefone foi recuperado como alteração pontual;
o servidor antigo não substitui esta versão.

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
