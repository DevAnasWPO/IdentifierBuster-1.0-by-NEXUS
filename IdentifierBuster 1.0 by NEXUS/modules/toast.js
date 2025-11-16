const TOAST_CONTAINER_ID = 'ib-toast-container';

const ensureContainer = () => {
    let container = document.getElementById(TOAST_CONTAINER_ID);
    if (!container) {
        container = document.createElement('div');
        container.id = TOAST_CONTAINER_ID;
        document.body.appendChild(container);
    }
    return container;
};

const typeClassMap = {
    info: 'ib-toast-info',
    success: 'ib-toast-success',
    warning: 'ib-toast-warning',
    error: 'ib-toast-error'
};

function createToast({ title, message, type = 'info', actions = [], duration } = {}) {
    const container = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `ib-toast ${typeClassMap[type] || typeClassMap.info}`;

    const header = document.createElement('div');
    header.className = 'ib-toast-header';
    header.textContent = title;
    toast.appendChild(header);

    let body = null;
    if (typeof message !== 'undefined') {
        body = document.createElement('div');
        body.className = 'ib-toast-body';
        body.textContent = message;
        toast.appendChild(body);
    }

    const resolvedDuration = typeof duration === 'number'
        ? duration
        : type === 'error'
            ? 0
            : 6000;

    let autoDismiss = null;
    if (resolvedDuration > 0) {
        autoDismiss = setTimeout(() => dismissToast(toast), resolvedDuration);
    }

    let actionRow = null;
    if (actions.length > 0) {
        actionRow = document.createElement('div');
        actionRow.className = 'ib-toast-actions';
        actions.forEach(action => {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.className = 'ib-toast-action';
            button.addEventListener('click', () => {
                try {
                    action.onClick?.();
                } finally {
                    dismissToast(toast);
                }
            });
            actionRow.appendChild(button);
        });
        toast.appendChild(actionRow);
    }

    const dismissButton = document.createElement('button');
    dismissButton.className = 'ib-toast-dismiss';
    dismissButton.innerHTML = '&times;';
    dismissButton.addEventListener('click', () => dismissToast(toast));
    toast.appendChild(dismissButton);

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('ib-toast-visible'));

    const api = {
        update: ({ title: nextTitle, message: nextMessage, type: nextType, duration: nextDuration } = {}) => {
            if (typeof nextTitle === 'string') {
                header.textContent = nextTitle;
            }
            if (typeof nextMessage !== 'undefined') {
                if (!body) {
                    body = document.createElement('div');
                    body.className = 'ib-toast-body';
                    toast.insertBefore(body, actionRow || dismissButton);
                }
                body.textContent = nextMessage;
            }
            if (nextType && nextType !== type) {
                toast.classList.remove(typeClassMap[type] || typeClassMap.info);
                type = nextType;
                toast.classList.add(typeClassMap[type] || typeClassMap.info);
            }
            if (typeof nextDuration === 'number') {
                if (autoDismiss) clearTimeout(autoDismiss);
                autoDismiss = nextDuration > 0
                    ? setTimeout(() => dismissToast(toast), nextDuration)
                    : null;
            }
        },
        dismiss: () => {
            if (autoDismiss) clearTimeout(autoDismiss);
            dismissToast(toast);
        }
    };

    return api;
}

function dismissToast(toastElement) {
    toastElement.classList.remove('ib-toast-visible');
    toastElement.addEventListener('transitionend', () => {
        toastElement.remove();
    }, { once: true });
}

export const toast = {
    info(payload) {
        return createToast({ ...payload, type: 'info' });
    },
    success(payload) {
        return createToast({ ...payload, type: 'success' });
    },
    warning(payload) {
        return createToast({ ...payload, type: 'warning' });
    },
    error(payload) {
        return createToast({ ...payload, type: 'error' });
    }
};
