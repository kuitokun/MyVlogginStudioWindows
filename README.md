# MyVloggingStudio para Windows

Editor de video de escritorio. Convierte solo los videos HEVC / 10 bits / D-Log M
(por ejemplo de DJI Osmo Action 4) y exporta cuadro por cuadro con FFmpeg hasta 4K.

## Usar el código fuente (Windows, Mac o Linux)
1. Instalá Node.js (versión LTS) desde nodejs.org
2. En esta carpeta: `npm install`
3. Abrir el editor: `npm start`
4. Armar el programa instalable: `npm run dist:win` (o `dist:mac`, `dist:linux`)

Las copias convertidas se guardan en la carpeta de datos de la app (`conversiones`)
y se reutilizan si volvés a importar el mismo archivo.

## Descargar el programa ya armado
En este repositorio, a la derecha: **Releases → MyVloggingStudio para Windows (última versión)** → bajá
`MyVloggingStudio-Windows.zip`, descomprimilo y abrí `MyVloggingStudio.exe`.
Cada vez que se suben cambios, GitHub vuelve a armar el programa solo (pestaña **Actions**).
