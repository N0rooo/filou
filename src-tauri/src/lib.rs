// Filou — le chien qui range tes fichiers.
// Tout est local : inventaire du Bureau et des Téléchargements, plan de
// rangement (heuristique, affinable par l'IA via Claude Code), déplacements
// annulables consignés dans un journal.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// Dossiers surveillés : (nom affiché, nom du dossier dans $HOME).
const ZONES: &[(&str, &str)] = &[("Bureau", "Desktop"), ("Téléchargements", "Downloads")];
const CLI_TIMEOUT: Duration = Duration::from_secs(300);
/// Nombre maximal de fichiers envoyés à l'IA (les plus récents d'abord).
const MAX_FICHIERS_IA: usize = 400;

#[derive(Serialize, Deserialize, Clone)]
struct Fiche {
    nom: String,
    chemin: String,
    taille: u64,
    modifie: u64,
    categorie: String,
}

#[derive(Serialize)]
struct Zone {
    nom: String,
    chemin: String,
    fichiers: Vec<Fiche>,
}

#[derive(Deserialize)]
struct Deplacement {
    chemin: String,
    dossier: String,
}

#[derive(Serialize)]
struct Bilan {
    ranges: u32,
    erreurs: Vec<String>,
    lignes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct EntreeJournal {
    ts: u64,
    resume: String,
    lignes: Vec<String>,
    deplacements: Vec<(String, String)>,
}

// --------------------------------------------------------------- inventaire

fn categoriser(nom: &str) -> String {
    let minuscule = nom.to_lowercase();
    for prefixe in [
        "cleanshot",
        "capture d'écran",
        "capture d’écran",
        "screenshot",
        "screen shot",
    ] {
        if minuscule.starts_with(prefixe) {
            return "Captures d'écran".into();
        }
    }
    let ext = Path::new(nom)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let table: &[(&str, &[&str])] = &[
        ("Images", &["png", "jpg", "jpeg", "gif", "webp", "heic", "svg", "tiff", "bmp", "ico"]),
        ("Vidéos", &["mp4", "mov", "mkv", "avi", "webm", "m4v"]),
        ("Audio", &["mp3", "wav", "aiff", "m4a", "flac", "ogg"]),
        ("Documents", &["pdf", "doc", "docx", "pages", "txt", "md", "rtf", "odt", "epub"]),
        ("Présentations", &["key", "ppt", "pptx"]),
        ("Tableurs", &["xls", "xlsx", "numbers", "csv", "ods"]),
        ("Archives", &["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"]),
        ("Installeurs", &["dmg", "pkg", "iso", "mpkg"]),
        (
            "Code",
            &["js", "ts", "tsx", "jsx", "py", "rs", "json", "sh", "html", "css", "sql", "ipynb",
              "toml", "yaml", "yml", "swift", "c", "h", "cpp", "go"],
        ),
        ("Polices", &["ttf", "otf", "woff", "woff2"]),
    ];
    for (cat, exts) in table {
        if exts.contains(&ext.as_str()) {
            return (*cat).into();
        }
    }
    "Divers".into()
}

fn dossier_zone(nom_systeme: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(nom_systeme))
}

#[tauri::command]
fn inventaire() -> Result<Vec<Zone>, String> {
    let mut zones = Vec::new();
    for (nom, dossier) in ZONES {
        let chemin = dossier_zone(dossier)?;
        let mut fichiers = Vec::new();
        let entrees = fs::read_dir(&chemin).map_err(|e| format!("Impossible de lire {nom} : {e}"))?;
        for entree in entrees.flatten() {
            let nom_fichier = entree.file_name().to_string_lossy().to_string();
            // Fichiers cachés et artefacts macOS : pas touche.
            if nom_fichier.starts_with('.') || nom_fichier == "Icon\r" {
                continue;
            }
            let Ok(meta) = entree.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let modifie = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            fichiers.push(Fiche {
                categorie: categoriser(&nom_fichier),
                chemin: entree.path().to_string_lossy().to_string(),
                nom: nom_fichier,
                taille: meta.len(),
                modifie,
            });
        }
        fichiers.sort_by(|a, b| a.categorie.cmp(&b.categorie).then(b.modifie.cmp(&a.modifie)));
        zones.push(Zone {
            nom: (*nom).into(),
            chemin: chemin.to_string_lossy().to_string(),
            fichiers,
        });
    }
    Ok(zones)
}

// ------------------------------------------------------------------ plan IA

fn find_claude_cli() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            let candidats = [
                "claude".to_string(),
                format!("{home}/.claude/local/claude"),
                "/opt/homebrew/bin/claude".to_string(),
                "/usr/local/bin/claude".to_string(),
                format!("{home}/.local/bin/claude"),
            ];
            for candidat in candidats {
                let ok = Command::new(&candidat)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .stdin(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    return Some(PathBuf::from(candidat));
                }
            }
            None
        })
        .clone()
}

fn run_claude_cli(bin: &PathBuf, modele: &str, prompt: &str) -> Result<String, String> {
    let mut args = vec!["-p", "--output-format", "json"];
    if !modele.trim().is_empty() {
        args.push("--model");
        args.push(modele);
    }
    let mut enfant = Command::new(bin)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Impossible de lancer Claude Code : {e}"))?;

    enfant
        .stdin
        .take()
        .ok_or("stdin indisponible")?
        .write_all(prompt.as_bytes())
        .map_err(|e| e.to_string())?;

    let debut = Instant::now();
    let statut = loop {
        match enfant.try_wait().map_err(|e| e.to_string())? {
            Some(statut) => break statut,
            None => {
                if debut.elapsed() > CLI_TIMEOUT {
                    let _ = enfant.kill();
                    return Err("Claude Code n'a pas répondu dans le délai imparti.".into());
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    };

    let mut sortie = String::new();
    if let Some(mut out) = enfant.stdout.take() {
        let _ = out.read_to_string(&mut sortie);
    }
    if !statut.success() {
        let mut erreur = String::new();
        if let Some(mut err) = enfant.stderr.take() {
            let _ = err.read_to_string(&mut erreur);
        }
        let detail = erreur.lines().last().unwrap_or("erreur inconnue");
        return Err(format!("Claude Code a échoué : {detail}"));
    }
    // --output-format json enveloppe la réponse : {"type":"result","result":"…"}.
    if let Ok(enveloppe) = sortie.parse::<serde_json::Value>() {
        if let Some(resultat) = enveloppe.get("result").and_then(|v| v.as_str()) {
            return Ok(resultat.to_string());
        }
    }
    Ok(sortie)
}

fn extraire_tableau_json(texte: &str) -> Result<serde_json::Value, String> {
    let debut = texte.find('[').ok_or("réponse sans tableau JSON")?;
    let fin = texte.rfind(']').ok_or("réponse sans tableau JSON")?;
    if fin <= debut {
        return Err("réponse sans tableau JSON".into());
    }
    texte[debut..=fin]
        .parse::<serde_json::Value>()
        .map_err(|e| format!("JSON illisible : {e}"))
}

/// Demande à l'IA un dossier de rangement pour chaque nom de fichier.
/// Le travail est découpé en lots traités par un petit pool parallèle, et la
/// progression (lots faits / total) est émise au frontend via « ia-progres ».
/// Async obligatoire : une commande synchrone tourne sur le thread principal
/// de Tauri et gèlerait toute la fenêtre le temps de la réponse.
#[tauri::command]
async fn plan_ia(
    app: tauri::AppHandle,
    fichiers: Vec<String>,
    modele: Option<String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        plan_ia_bloquant(&app, fichiers, modele.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ce que le frontend doit savoir sur l'IA : CLI détecté ? clé enregistrée ?
#[derive(Serialize)]
struct EtatIa {
    cli: Option<String>,
    cle: bool,
}

#[tauri::command]
async fn etat_ia() -> EtatIa {
    tauri::async_runtime::spawn_blocking(|| EtatIa {
        cli: find_claude_cli().map(|p| p.to_string_lossy().to_string()),
        cle: cle_api().is_some(),
    })
    .await
    .unwrap_or(EtatIa { cli: None, cle: false })
}

const LOT_IA: usize = 60;
const TRAVAILLEURS_IA: usize = 4;
const KEYRING_SERVICE: &str = "filou";
const API_URL: &str = "https://api.anthropic.com/v1/messages";

/// Source d'authentification IA : clé API si enregistrée, sinon le CLI.
enum AuthIa {
    Cle(String),
    Cli(PathBuf),
}

fn cle_api() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, "anthropic-api-key")
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|v| !v.trim().is_empty())
}

/// Identifiant de modèle complet pour l'API (le CLI accepte les alias, pas l'API).
fn modele_api(modele: &str) -> &'static str {
    match modele {
        "sonnet" => "claude-sonnet-5",
        "opus" => "claude-opus-5",
        _ => "claude-haiku-4-5-20251001",
    }
}

fn request_via_api(cle: &str, modele: &str, prompt: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": modele_api(modele),
        "max_tokens": 8000,
        "output_config": {"effort": "low"},
        "messages": [{"role": "user", "content": prompt}]
    });
    let reponse = client
        .post(API_URL)
        .header("x-api-key", cle)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("Appel à l'API Claude impossible : {e}"))?;
    let statut = reponse.status();
    let valeur: serde_json::Value = reponse
        .json()
        .map_err(|e| format!("Réponse de l'API Claude illisible : {e}"))?;
    if !statut.is_success() {
        let message = valeur
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("erreur inconnue");
        return Err(format!("API Claude : {message}"));
    }
    valeur
        .pointer("/content/0/text")
        .and_then(|v| v.as_str())
        .map(|t| t.to_string())
        .ok_or_else(|| "Réponse de l'API Claude sans texte.".into())
}

#[tauri::command]
async fn definir_cle_api(cle: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entree = keyring::Entry::new(KEYRING_SERVICE, "anthropic-api-key")
            .map_err(|e| e.to_string())?;
        if cle.trim().is_empty() {
            let _ = entree.delete_credential();
            Ok(false)
        } else {
            entree.set_password(cle.trim()).map_err(|e| e.to_string())?;
            Ok(true)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
struct ProgresIa {
    fait: usize,
    total: usize,
}

fn emettre_progres(app: &tauri::AppHandle, fait: usize, total: usize) {
    use tauri::Emitter;
    let _ = app.emit("ia-progres", ProgresIa { fait, total });
}

fn plan_ia_bloquant(
    app: &tauri::AppHandle,
    fichiers: Vec<String>,
    modele: String,
) -> Result<HashMap<String, String>, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let auth = match cle_api() {
        Some(cle) => AuthIa::Cle(cle),
        None => AuthIa::Cli(find_claude_cli().ok_or(
            "Aucune IA disponible : ajoute ta clé API dans les Réglages ou installe Claude Code.",
        )?),
    };
    let retenus: Vec<String> = fichiers.into_iter().take(MAX_FICHIERS_IA).collect();
    let lots: Vec<&[String]> = retenus.chunks(LOT_IA).collect();
    let total = lots.len();
    emettre_progres(app, 0, total);

    let indice = AtomicUsize::new(0);
    let fait = AtomicUsize::new(0);
    let resultats: Vec<Result<HashMap<String, String>, String>> = std::thread::scope(|scope| {
        let mut mains = Vec::new();
        for _ in 0..total.min(TRAVAILLEURS_IA) {
            mains.push(scope.spawn(|| {
                let mut miens = Vec::new();
                loop {
                    let i = indice.fetch_add(1, Ordering::Relaxed);
                    let Some(lot) = lots.get(i) else { break };
                    miens.push(classer_lot(&auth, &modele, lot));
                    let f = fait.fetch_add(1, Ordering::Relaxed) + 1;
                    emettre_progres(app, f, total);
                }
                miens
            }));
        }
        mains
            .into_iter()
            .flat_map(|m| m.join().unwrap_or_default())
            .collect()
    });

    let mut table = HashMap::new();
    let mut derniere_erreur: Option<String> = None;
    for r in resultats {
        match r {
            Ok(t) => table.extend(t),
            Err(e) => derniere_erreur = Some(e),
        }
    }
    if table.is_empty() {
        return Err(derniere_erreur.unwrap_or_else(|| "L'IA n'a rien proposé d'exploitable.".into()));
    }
    Ok(table)
}

fn classer_lot(
    auth: &AuthIa,
    modele: &str,
    lot: &[String],
) -> Result<HashMap<String, String>, String> {
    let liste = lot.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n");
    let prompt = format!(
        "Tu ranges les fichiers en vrac du Bureau et des Téléchargements d'un utilisateur \
         français. Pour chaque nom de fichier ci-dessous, propose un dossier de rangement \
         court en français, éventuellement avec un sous-dossier (« Dossier » ou \
         « Dossier/Sous-dossier », deux niveaux maximum). Regroupe fortement et tiens-toi \
         aux racines suggérées : Captures d'écran, Images, Documents, Factures, \
         Installeurs, Archives, Code, Vidéos, Audio, Divers — n'en crée d'autres que si \
         un vrai thème le mérite (un projet reconnaissable, par exemple). Réponds \
         UNIQUEMENT par un tableau JSON, sans aucun texte autour : \
         [{{\"fichier\": \"nom exact\", \"dossier\": \"…\"}}]\n\n{liste}"
    );
    let reponse = match auth {
        AuthIa::Cle(cle) => request_via_api(cle, modele, &prompt)?,
        AuthIa::Cli(bin) => run_claude_cli(bin, modele, &prompt)?,
    };
    let tableau = extraire_tableau_json(&reponse)?;
    let mut table = HashMap::new();
    if let Some(items) = tableau.as_array() {
        for item in items {
            let (Some(fichier), Some(dossier)) = (
                item.get("fichier").and_then(|v| v.as_str()),
                item.get("dossier").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            table.insert(fichier.to_string(), nettoyer_dossier(dossier));
        }
    }
    Ok(table)
}

/// Garde-fou sur les chemins proposés (par l'IA ou le frontend) : pas de
/// remontée « .. », pas d'absolu, deux niveaux maximum.
fn nettoyer_dossier(dossier: &str) -> String {
    let propre: Vec<&str> = dossier
        .split('/')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
        .take(2)
        .collect();
    if propre.is_empty() {
        "Divers".into()
    } else {
        propre.join("/")
    }
}

// ---------------------------------------------------------------- rangement

fn zones_autorisees() -> Vec<PathBuf> {
    ZONES
        .iter()
        .filter_map(|(_, d)| dossier_zone(d).ok())
        .collect()
}

fn destination_libre(dossier: &Path, nom: &str) -> PathBuf {
    let base = dossier.join(nom);
    if !base.exists() {
        return base;
    }
    let (radical, ext) = match nom.rfind('.') {
        Some(i) if i > 0 => (&nom[..i], &nom[i..]),
        _ => (nom, ""),
    };
    for n in 2..1000 {
        let candidat = dossier.join(format!("{radical} {n}{ext}"));
        if !candidat.exists() {
            return candidat;
        }
    }
    dossier.join(format!("{radical} {}{ext}", horodatage()))
}

fn horodatage() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn ranger(app: tauri::AppHandle, deplacements: Vec<Deplacement>) -> Result<Bilan, String> {
    tauri::async_runtime::spawn_blocking(move || ranger_bloquant(app, deplacements))
        .await
        .map_err(|e| e.to_string())?
}

fn ranger_bloquant(app: tauri::AppHandle, deplacements: Vec<Deplacement>) -> Result<Bilan, String> {
    let autorisees = zones_autorisees();
    let mut faits: Vec<(String, String)> = Vec::new();
    let mut erreurs = Vec::new();
    let mut par_dossier: HashMap<String, u32> = HashMap::new();

    for d in &deplacements {
        let source = PathBuf::from(&d.chemin);
        let Some(parent) = source.parent().map(Path::to_path_buf) else {
            continue;
        };
        // On ne déplace que des fichiers posés directement dans une zone gérée.
        if !autorisees.iter().any(|z| z == &parent) {
            erreurs.push(format!("{} : hors des dossiers gérés, ignoré", d.chemin));
            continue;
        }
        if !source.is_file() {
            continue; // disparu entre l'analyse et le rangement
        }
        let dossier = nettoyer_dossier(&d.dossier);
        let cible_dir = parent.join(&dossier);
        if let Err(e) = fs::create_dir_all(&cible_dir) {
            erreurs.push(format!("{dossier} : {e}"));
            continue;
        }
        let nom = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let cible = destination_libre(&cible_dir, &nom);
        match fs::rename(&source, &cible) {
            Ok(()) => {
                faits.push((
                    source.to_string_lossy().to_string(),
                    cible.to_string_lossy().to_string(),
                ));
                *par_dossier.entry(dossier.clone()).or_insert(0) += 1;
            }
            Err(e) => erreurs.push(format!("{nom} : {e}")),
        }
    }

    let mut lignes: Vec<(String, u32)> = par_dossier.into_iter().collect();
    lignes.sort_by(|a, b| b.1.cmp(&a.1));
    let lignes: Vec<String> = lignes
        .into_iter()
        .map(|(dossier, n)| format!("« {dossier} » — {n} fichier{}", if n > 1 { "s" } else { "" }))
        .collect();

    let ranges = faits.len() as u32;
    if ranges > 0 {
        let resume = format!(
            "Rangement : {ranges} fichier{} déplacé{}",
            if ranges > 1 { "s" } else { "" },
            if ranges > 1 { "s" } else { "" }
        );
        journal_prepend(
            &app,
            EntreeJournal {
                ts: horodatage(),
                resume,
                lignes: lignes.clone(),
                deplacements: faits,
            },
        )?;
    }
    Ok(Bilan { ranges, erreurs, lignes })
}

// ------------------------------------------------------------------ journal

fn chemin_journal(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("journal.json"))
}

fn journal_charger(app: &tauri::AppHandle) -> Result<Vec<EntreeJournal>, String> {
    let chemin = chemin_journal(app)?;
    if !chemin.exists() {
        return Ok(Vec::new());
    }
    let texte = fs::read_to_string(&chemin).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&texte).unwrap_or_default())
}

fn journal_sauver(app: &tauri::AppHandle, entrees: &[EntreeJournal]) -> Result<(), String> {
    let chemin = chemin_journal(app)?;
    let texte = serde_json::to_string_pretty(entrees).map_err(|e| e.to_string())?;
    fs::write(chemin, texte).map_err(|e| e.to_string())
}

fn journal_prepend(app: &tauri::AppHandle, entree: EntreeJournal) -> Result<(), String> {
    let mut entrees = journal_charger(app)?;
    entrees.insert(0, entree);
    entrees.truncate(100);
    journal_sauver(app, &entrees)
}

#[tauri::command]
fn journal_liste(app: tauri::AppHandle) -> Result<Vec<EntreeJournal>, String> {
    journal_charger(&app)
}

/// Annule le dernier rangement (uniquement lui : les suivants dépendraient
/// d'un état du disque qui n'existe plus). Remet chaque fichier à sa place
/// et supprime les dossiers créés devenus vides.
#[tauri::command]
async fn annuler(app: tauri::AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || annuler_bloquant(app))
        .await
        .map_err(|e| e.to_string())?
}

fn annuler_bloquant(app: tauri::AppHandle) -> Result<u32, String> {
    let mut entrees = journal_charger(&app)?;
    let Some(position) = entrees.iter().position(|e| !e.deplacements.is_empty()) else {
        return Err("Rien à annuler.".into());
    };
    if position != 0 {
        return Err("Seul le dernier rangement peut être annulé.".into());
    }
    let entree = entrees.remove(0);
    let mut remis = 0u32;
    let mut dossiers_crees: Vec<PathBuf> = Vec::new();
    for (de, vers) in &entree.deplacements {
        let source = PathBuf::from(vers);
        let retour = PathBuf::from(de);
        if !source.is_file() || retour.exists() {
            continue;
        }
        if fs::rename(&source, &retour).is_ok() {
            remis += 1;
            if let Some(parent) = source.parent() {
                dossiers_crees.push(parent.to_path_buf());
            }
        }
    }
    // Nettoie les dossiers de rangement vides (remove_dir refuse les non-vides).
    dossiers_crees.sort();
    dossiers_crees.dedup();
    let zones = zones_autorisees();
    for dossier in dossiers_crees {
        let _ = fs::remove_dir(&dossier);
        // Cas « Dossier/Sous-dossier » : le parent peut lui aussi être vide.
        if let Some(parent) = dossier.parent() {
            let parent_dans_zone = parent
                .parent()
                .map(|pp| zones.iter().any(|z| z == pp))
                .unwrap_or(false);
            if parent_dans_zone {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    entrees.insert(
        0,
        EntreeJournal {
            ts: horodatage(),
            resume: format!(
                "Annulation : {remis} fichier{} remis à leur place",
                if remis > 1 { "s" } else { "" }
            ),
            lignes: Vec::new(),
            deplacements: Vec::new(),
        },
    );
    entrees.truncate(100);
    journal_sauver(&app, &entrees)?;
    Ok(remis)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            inventaire,
            plan_ia,
            etat_ia,
            definir_cle_api,
            ranger,
            journal_liste,
            annuler
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
