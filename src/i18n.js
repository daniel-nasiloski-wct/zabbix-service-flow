// Textos do mapa no idioma do usuário do Zabbix. O PHP (CI18n, gettext do módulo) manda no bootstrap
// um dicionário {inglês: traduzido} só com o que tem tradução; o que faltar fica em inglês, como o
// próprio Zabbix faz. Os marcadores são os mesmos do _s() do Zabbix: %1$s, %2$s…
let strings = {}
let locale = 'en-US'

export function setI18n(map, lang) {
  strings = map && typeof map === 'object' ? map : {}
  const tag = String(lang || 'en_US').replace('_', '-')
  try {
    new Intl.NumberFormat(tag)
    locale = tag
  } catch {
    locale = 'en-US'
  }
}

export const getLocale = () => locale

export function t(text, ...args) {
  let out = Object.prototype.hasOwnProperty.call(strings, text) && strings[text] ? strings[text] : text
  args.forEach((a, i) => { out = out.split(`%${i + 1}$s`).join(String(a)) })
  return out
}
