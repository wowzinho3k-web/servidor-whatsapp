document.addEventListener('DOMContentLoaded', () => {
  const btnBuscar = document.getElementById('btnBuscar');
  const btnCopiar = document.getElementById('btnCopiar');
  const statusDiv = document.getElementById('status');
  const resultadoDiv = document.getElementById('resultado');

  btnBuscar.addEventListener('click', async () => {
    const inputQuant =
      document.getElementById('quant') ||
      document.getElementById('quantidade') ||
      document.querySelector('input[type="number"]');

    const quantidade = inputQuant
      ? (parseInt(inputQuant.value, 10) || 10)
      : 10;

    statusDiv.innerText =
      `Buscando ${quantidade} ofertas na ordem da página...`;

    resultadoDiv.value = '';

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (
      !tab ||
      !tab.url ||
      !tab.url.includes('mercadolivre.com.br')
    ) {
      alert(
        'Abra primeiro a página da Central de Afiliados do Mercado Livre!'
      );

      statusDiv.innerText =
        'Abra a Central de Afiliados primeiro.';

      return;
    }

    try {
      const results =
        await chrome.scripting.executeScript({
          target: {
            tabId: tab.id
          },

          func: extrairOfertasEmOrdem,

          args: [
            quantidade
          ]
        });

      if (
        !results ||
        !results[0] ||
        !results[0].result
      ) {
        statusDiv.innerText =
          'Erro ao ler a página. Recarregue a página (F5).';

        return;
      }

      const ofertas =
        results[0].result;

      if (
        ofertas.length === 0
      ) {
        statusDiv.innerText =
          'Nenhum anúncio encontrado.';

        return;
      }

      const listaMensagens =
        ofertas.map(
          item => {

            let bloco =
              `🔥 OFERTA MERCADO LIVRE 🔥\n\n`;

            bloco +=
              `📦 ${item.titulo}\n\n`;

            if (
              item.precoOriginalFormatado &&
              item.precoOriginalNumerico >
                item.precoNumerico
            ) {
              bloco +=
                `❌ De: ~R$ ${item.precoOriginalFormatado}~\n`;
            }

            bloco +=
              `💥 Por: R$ ${item.preco}\n\n`;

            bloco +=
              `Clique aqui\n`;

            bloco +=
              `👉 ${item.link}`;

            return bloco;
          }
        ).join(
          '\n\n-------------------------\n\n'
        );

      resultadoDiv.value =
        listaMensagens;

      statusDiv.innerText =
        `✅ ${ofertas.length} ofertas prontas, na ordem da página.`;

    } catch (err) {

      console.error(err);

      statusDiv.innerText =
        'Erro de execução no navegador.';
    }
  });


  btnCopiar.addEventListener(
    'click',
    () => {

      const texto =
        resultadoDiv.value;

      if (
        !texto.trim()
      ) {
        alert(
          'Faça uma busca primeiro!'
        );

        return;
      }

      resultadoDiv.select();

      resultadoDiv.setSelectionRange(
        0,
        99999
      );

      try {
        document.execCommand(
          'copy'
        );

        const textoOriginal =
          btnCopiar.innerText;

        btnCopiar.innerText =
          '✅ Copiado com Sucesso!';

        btnCopiar.style.backgroundColor =
          '#059669';

        setTimeout(
          () => {

            btnCopiar.innerText =
              textoOriginal;

            btnCopiar.style.backgroundColor =
              '#10b981';

          },
          2000
        );

      } catch (err) {

        alert(
          'Selecione o texto e pressione Ctrl+C.'
        );
      }
    }
  );
});



// ======================================================
// FUNÇÃO QUE RODA DENTRO DA PÁGINA DO MERCADO LIVRE
// ======================================================

async function extrairOfertasEmOrdem(
  qtdDesejada
) {

  const esperar =
    ms =>
      new Promise(
        resolve =>
          setTimeout(
            resolve,
            ms
          )
      );


  const SELETOR_CARD =
    'li.poly-card, li[class*="poly-card"]';


  const TAG_AFILIADO =
    'multiofertasro';


  const produtos =
    [];


  const idsJaSalvos =
    new Set();



  // ======================================================
  // CONVERTER VALOR BRASILEIRO
  // ======================================================

  function numeroBrasileiro(
    texto
  ) {

    if (!texto) {
      return 0;
    }


    const limpo =
      String(texto)
        .replace(
          /[^0-9,.]/g,
          ''
        )
        .trim();


    if (!limpo) {
      return 0;
    }


    const numero =
      parseFloat(
        limpo
          .replace(
            /\./g,
            ''
          )
          .replace(
            ',',
            '.'
          )
      );


    return Number.isFinite(
      numero
    )
      ? numero
      : 0;
  }



  // ======================================================
  // GERAR LINK CURTO DE AFILIADO
  // ======================================================

  async function gerarLinkCurto(
    itemId,
    itemAddToList,
    urlOrigem
  ) {

    try {

      const resposta =
        await fetch(
          'https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink',
          {
            method:
              'POST',

            credentials:
              'include',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                itemId:
                  itemId,

                type:
                  'product',

                extraCommission:
                  'false',

                itemAddToList:
                  itemAddToList,

                tag:
                  TAG_AFILIADO,

                urls: [
                  urlOrigem
                ]
              })
          }
        );


      if (
        !resposta.ok
      ) {
        return null;
      }


      const dados =
        await resposta.json();


      if (
        dados &&
        Array.isArray(
          dados.urls
        ) &&
        dados.urls[0] &&
        dados.urls[0].short_url
      ) {

        return (
          dados.urls[0].short_url
        );
      }


      return null;

    } catch (e) {

      return null;
    }
  }



  // ======================================================
  // LER UM CARD
  // ======================================================

  function lerCard(
    card
  ) {

    if (
      !card ||
      card.offsetParent === null
    ) {
      return null;
    }


    if (
      card.closest(
        '[class*="carousel"], [class*="slider"], [class*="banner"]'
      )
    ) {
      return null;
    }


    const rect =
      card.getBoundingClientRect();


    if (
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }


    const linkEl =
      card.querySelector(
        'a.poly-component__title, a[class*="title"], a[href*="mercadolivre.com.br"]'
      );


    if (
      !linkEl ||
      !linkEl.href
    ) {
      return null;
    }


    let urlObj;


    try {

      urlObj =
        new URL(
          linkEl.href
        );

    } catch (e) {

      return null;
    }


    const matchMLB =
      urlObj.pathname.match(
        /MLB-?\d+/i
      );


    if (
      !matchMLB
    ) {
      return null;
    }


    const itemId =
      matchMLB[0]
        .toUpperCase()
        .replace(
          '-',
          ''
        );


    // ======================================================
    // TÍTULO
    // ======================================================

    let titulo =
      '';


    const elTitulo =
      card.querySelector(
        '.poly-component__title, h2, h3, h4, [class*="title"], [class*="name"]'
      );


    if (
      elTitulo
    ) {

      const candidato =
        elTitulo.innerText
          .replace(
            /\n/g,
            ' '
          )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();


      if (
        candidato &&
        candidato.length > 8 &&
        !candidato
          .toLowerCase()
          .includes(
            'produtos selecionados'
          )
      ) {

        titulo =
          candidato;
      }
    }


    if (
      !titulo
    ) {

      const candidatoLink =
        linkEl.innerText
          .replace(
            /\n/g,
            ' '
          )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();


      if (
        candidatoLink.length > 8 &&
        !candidatoLink
          .toLowerCase()
          .includes(
            'produtos selecionados'
          )
      ) {

        titulo =
          candidatoLink;
      }
    }


    if (
      !titulo
    ) {
      return null;
    }



    // ======================================================
    // PREÇO ANTIGO
    // ======================================================

    let precoOriginalFormatado =
      null;


    let precoOriginalNumerico =
      0;


    const elOriginal =
      card.querySelector(
        's, .poly-price__original, [class*="original"], [class*="strikethrough"], [class*="prev"]'
      );


    if (
      elOriginal
    ) {

      const textoOriginal =
        elOriginal.innerText
          .replace(
            /[^0-9,.]/g,
            ''
          )
          .trim();


      const valorOriginal =
        numeroBrasileiro(
          textoOriginal
        );


      if (
        valorOriginal > 5
      ) {

        precoOriginalFormatado =
          textoOriginal;


        precoOriginalNumerico =
          valorOriginal;
      }
    }



    // ======================================================
    // PREÇO ATUAL
    // ======================================================

    const blocosPreco =
      Array.from(
        card.querySelectorAll(
          '.poly-price__current .andes-money-amount, .andes-money-amount'
        )
      );


    const candidatosPreco =
      [];


    for (
      const bloco of blocosPreco
    ) {

      if (
        bloco.closest('s') ||
        bloco.closest(
          '.poly-price__original'
        ) ||
        bloco.closest(
          '[class*="original"]'
        )
      ) {

        continue;
      }


      const texto =
        bloco.innerText
          .replace(
            /\n/g,
            ''
          )
          .replace(
            /[^0-9,.]/g,
            ''
          )
          .trim();


      const valor =
        numeroBrasileiro(
          texto
        );


      if (
        valor > 5
      ) {

        candidatosPreco.push({
          texto,
          valor
        });
      }
    }


    if (
      candidatosPreco.length === 0
    ) {

      return null;
    }


    let principal =
      candidatosPreco.find(
        c =>
          c.valor !==
          precoOriginalNumerico
      );


    if (
      !principal
    ) {

      principal =
        candidatosPreco[0];
    }


    const preco =
      principal.texto;


    const precoNumerico =
      principal.valor;


    if (
      precoOriginalNumerico <=
      precoNumerico
    ) {

      precoOriginalFormatado =
        null;


      precoOriginalNumerico =
        0;
    }



    // ======================================================
    // DADOS DO ANÚNCIO
    // ======================================================

    const inputId =
      card.querySelector(
        'input[name="id"]'
      );


    const itemAddToList =
      inputId
        ? inputId.value
        : urlObj.searchParams.get(
            'wid'
          );


    const urlOrigem =
      urlObj.origin +
      urlObj.pathname;


    return {

      itemId,

      itemAddToList,

      urlOrigem,

      titulo,

      preco,

      precoNumerico,

      precoOriginalFormatado,

      precoOriginalNumerico,

      top:
        rect.top,

      left:
        rect.left

    };
  }



  // ======================================================
  // COMEÇAR SEMPRE DO TOPO
  // ======================================================

  window.scrollTo({
    top:
      0,

    behavior:
      'auto'
  });


  await esperar(
    1500
  );


  let semNovos =
    0;


  let ciclos =
    0;


  const MAX_CICLOS =
    80;



  // ======================================================
  // VARREDURA EM ORDEM REAL
  // ======================================================

  while (
    produtos.length <
      qtdDesejada &&
    ciclos <
      MAX_CICLOS &&
    semNovos <
      8
  ) {

    ciclos++;


    const quantidadeAntes =
      produtos.length;


    const cards =
      Array.from(
        document.querySelectorAll(
          SELETOR_CARD
        )
      );


    const destaFaixa =
      [];


    for (
      const card of cards
    ) {

      const dados =
        lerCard(
          card
        );


      if (
        !dados
      ) {
        continue;
      }


      if (
        idsJaSalvos.has(
          dados.itemId
        )
      ) {
        continue;
      }


      // Não deixa um anúncio muito abaixo
      // entrar antes dos anúncios visíveis.

      if (
        dados.top >
        window.innerHeight *
          1.35
      ) {
        continue;
      }


      if (
        dados.top <
        -500
      ) {
        continue;
      }


      destaFaixa.push(
        dados
      );
    }



    // ======================================================
    // ORDEM VISUAL
    // TOPO -> BAIXO
    // ESQUERDA -> DIREITA
    // ======================================================

    destaFaixa.sort(
      (
        a,
        b
      ) => {

        if (
          Math.abs(
            a.top -
            b.top
          ) >
          35
        ) {

          return (
            a.top -
            b.top
          );
        }


        return (
          a.left -
          b.left
        );
      }
    );



    // ======================================================
    // SALVAR NA ORDEM
    // ======================================================

    for (
      const item of destaFaixa
    ) {

      if (
        produtos.length >=
        qtdDesejada
      ) {
        break;
      }


      if (
        idsJaSalvos.has(
          item.itemId
        )
      ) {
        continue;
      }


      // Reserva o ID antes de gerar o link.
      // Assim ele nunca troca de posição depois.

      idsJaSalvos.add(
        item.itemId
      );


      let linkFinal =
        await gerarLinkCurto(
          item.itemId,
          item.itemAddToList,
          item.urlOrigem
        );


      if (
        !linkFinal
      ) {

        const extras =
          [];


        if (
          item.itemAddToList
        ) {

          extras.push(
            `wid=${encodeURIComponent(
              item.itemAddToList
            )}`
          );
        }


        linkFinal =
          item.urlOrigem;


        if (
          extras.length
        ) {

          linkFinal +=
            `?${extras.join('&')}`;
        }
      }


      produtos.push({

        ordem:
          produtos.length + 1,

        id:
          item.itemId,

        titulo:
          item.titulo,

        link:
          linkFinal,

        preco:
          item.preco,

        precoNumerico:
          item.precoNumerico,

        precoOriginalFormatado:
          item.precoOriginalFormatado,

        precoOriginalNumerico:
          item.precoOriginalNumerico

      });


      await esperar(
        300
      );
    }



    // ======================================================
    // VER SE ENCONTROU NOVOS
    // ======================================================

    if (
      produtos.length ===
      quantidadeAntes
    ) {

      semNovos++;

    } else {

      semNovos =
        0;
    }


    if (
      produtos.length >=
      qtdDesejada
    ) {

      break;
    }



    // ======================================================
    // ROLAR DEVAGAR
    // ======================================================

    const posicaoAntes =
      window.scrollY;


    const alturaAntes =
      document.documentElement
        .scrollHeight;


    window.scrollBy({

      top:
        Math.max(
          450,
          Math.floor(
            window.innerHeight *
            0.72
          )
        ),

      behavior:
        'auto'

    });


    await esperar(
      1200
    );



    const chegouNoFim =

      window.scrollY +
      window.innerHeight >=

      document.documentElement
        .scrollHeight -
      150;



    // Se chegou no fim,
    // força a página a carregar mais.

    if (
      chegouNoFim
    ) {

      window.scrollTo({

        top:
          alturaAntes,

        behavior:
          'auto'

      });


      await esperar(
        1600
      );
    }



    if (
      window.scrollY ===
        posicaoAntes &&
      chegouNoFim
    ) {

      semNovos++;
    }
  }



  // ======================================================
  // RETORNO FINAL
  // ======================================================

  return produtos
    .slice(
      0,
      qtdDesejada
    );
}
