# Cómo contribuir

¡Gracias por querer ayudar! Lo que más falta es **entender el formato de la partida**, y para eso no hace falta programar.

## Reportar un descubrimiento del formato

1. Antes de hacer algo en el juego, descarga una copia de seguridad (en nfsu2.xyz: **Descargar copia de seguridad**).
2. Haz **un solo cambio** en el juego: comprar un auto, desbloquear un espacio del garaje, ganar una carrera, cambiar la pintura… y guarda.
3. Descarga otra copia.
4. En el editor abre **Comparar partidas**, carga la de antes como **A** y la de después como **B**.
5. Marca **Ocultar zonas conocidas** y fíjate qué zonas cambiaron.
6. Abre un *issue* con la plantilla **Descubrimiento del formato**: qué hiciste en el juego, las posiciones que cambiaron y sus valores (puedes adjuntar el CSV exportado).

**No adjuntes tus partidas** si no quieres compartirlas: con las posiciones y los valores alcanza.

## Reportar un error

Usa la plantilla **Error**: navegador, qué hiciste, qué esperabas y qué pasó.

## Cambios en el código

- No hay dependencias ni compilación: abre `index.html` y listo.
- Corre `npm test` antes de enviar un *pull request* (Node 18 o superior).
- Los textos de la interfaz están en `src/i18n.js`: si agregas uno, agrégalo en los tres idiomas (es, en, pt).
- Nunca subas partidas ni respaldos `.zip` al repositorio.
