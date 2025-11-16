export async function printSidebar() {
    let main = null;
    while (!main) {
        main = document.getElementById("RCONContainer");
        await new Promise(r => { setTimeout(() => { r() }, 100); })
    }

    const container = document.createElement("div")
    container.id = "settings-sidebar";
    main.appendChild(container);

    const settingsWrapper = document.createElement("div");
    settingsWrapper.id = "settings-wrapper";
    container.appendChild(settingsWrapper)


    const title = document.createElement("h1");
    title.innerText = "Settings: "
    settingsWrapper.appendChild(title);

    const img = document.createElement("img");
    img.id = "settings-button";
    img.src = chrome.runtime.getURL('images/settings.png');
    img.addEventListener("click", async () => { printSettings() });
    settingsWrapper.appendChild(img);
}
export async function printSettings() {
    let main = null;
    while (!main) {
        main = document.getElementById("RCONContainer");
        await new Promise(r => { setTimeout(() => { r() }, 100); })
    }


    const wrapper = document.createElement("div");
    wrapper.id = "settings-window-wrapper";
    wrapper.addEventListener("click", (e) => {
        if (e.target.id !== "settings-window-wrapper") return;
        const item = document.getElementById("settings-window-wrapper");
        if (item) item.remove();
    })

    const settingWindow = document.createElement("div");
    settingWindow.id = "settings-window";
    wrapper.append(settingWindow);

    const steamApiKeySettings = getApiKeySettings("steam");
    settingWindow.appendChild(steamApiKeySettings)

    const rustApiKeySettings = getApiKeySettings("rust")
    settingWindow.appendChild(rustApiKeySettings)

    const colorSettings = getColorSettings();
    settingWindow.appendChild(colorSettings);

    main.appendChild(wrapper)
}

function getApiKeySettings(type) {
    const container = document.createElement("div");
    container.classList.add("key-settings");

    let key = null;
    if (type == "steam") key = localStorage.getItem('BMF_STEAM_API_KEY');
    if (type == "rust") key = localStorage.getItem('BMF_RUST_API_KEY')

    const title = document.createElement("h1");
    title.innerText = `${type == "steam" ? "Steam" : "Rust"} Api Key Settings:`;
    container.appendChild(title);

    const paragraph = document.createElement("p");
    paragraph.id = type == "steam" ? "steam-paragraph" : "rust-paragraph";
    paragraph.innerText = key ? `Your key starts with: ${key.substring(0, 10)}...` : `You have no key saved.`;
    container.appendChild(paragraph);

    const inputContainer = document.createElement("div");
    inputContainer.classList.add("key-setting-input-wrapper")
    container.appendChild(inputContainer);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = type == "steam" ? "Enter Steam Api Key..." : "Enter Rust Api Key...";
    input.classList.add("key-input");
    input.id = type == "steam" ? "steam-input" : "rust-input";
    inputContainer.appendChild(input)

    const inputButton = document.createElement("button");
    inputButton.classList.add("key-button")
    inputButton.innerText = "Update";
    inputButton.addEventListener("click", () => {
        const input = document.getElementById(type == "steam" ? "steam-input" : "rust-input");
        const value = input.value;
        
        const innerParagraph = document.getElementById(type == "steam" ? "steam-paragraph" : "rust-paragraph");
        innerParagraph.innerText = value ? `Your key starts with: ${value.substring(0, 10)}...` : `You have no key saved.`;        

        if (value) localStorage.setItem(type == "steam" ? "BMF_STEAM_API_KEY" : "BMF_RUST_API_KEY", value);
        else localStorage.removeItem(type == "steam" ? "BMF_STEAM_API_KEY" : "BMF_RUST_API_KEY");
    })
    inputContainer.appendChild(inputButton);

    return container;
}
function getColorSettings() {
    const container = document.createElement("div");
    container.id = "color-settings";

    const title = document.createElement("h1");
    title.innerText = "Color Settings:";
    container.appendChild(title);

    let savedColors = null;
    savedColors = JSON.parse(localStorage.getItem("bmf-colors"))

    if (!savedColors) {
        savedColors = {
            seenOnOrigin: "#00aaff10",
            seenOnFriend: "#ae6a3d10"
        };
    }

    function createColorInput(labelText, key) {
        const wrapper = document.createElement("div");
        wrapper.classList.add("color-setting-wrapper")

        const label = document.createElement("label");
        label.innerText = labelText;

        const input = document.createElement("input");
        input.type = "color";
        input.value = savedColors[key].substring(0, 7);

        input.addEventListener("input", () => {            
            savedColors[key] = input.value+"10";            
            localStorage.setItem("bmf-colors", JSON.stringify(savedColors));
        });

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        return wrapper;
    }

    container.appendChild(createColorInput("Seen On Origin", "seenOnOrigin"));
    container.appendChild(createColorInput("Seen On Friend", "seenOnFriend"));

    return container;
}